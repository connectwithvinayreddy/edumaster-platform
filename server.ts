import express from "express";
import http from "http";
import { createServer as createViteServer } from "vite";
import path from "path";
import { createRequire } from "module";
import crypto from "crypto";
import Razorpay from "razorpay";
import dotenv from "dotenv";

dotenv.config();

const require = createRequire(import.meta.url);
const { app: backendApp } = require("./backend/server.cjs");
const { app: manifestApp } = require("./backend/manifest-server.cjs");
const { requireAuth } = require("./backend/middleware/auth.js");
const { appConfig, getProductionConfigDiagnostics } = require("./backend/lib/config.js");
const { connectDatabase } = require("./backend/lib/database.js");
const { paymentRepository, coursesRepository } = require("./backend/lib/repositories.js");
const { verifyRazorpayWebhookSignature } = require("./backend/payment/razorpay-client.js");
const { startLiveEventBus } = require("./backend/live/live-event-bus.js");
const { ensureReplayImporterWorker } = require("./backend/live/live-replay.worker.js");
const { startMockTestRankingWorker, recoverPendingMockTestRankJobs } = require("./backend/test/mock-test-ranking.worker.js");
const { recoverPendingCourseVideoProcessingJobs, startVideoProcessingRecoveryLoop } = require("./backend/lib/video-processing.js");

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  })
  : null;

const buildMediaPermissionsPolicy = () => {
  const allowedOrigins = [`https://${appConfig.jitsiMeetDomain}`];

  if (appConfig.livekitUrl) {
    try {
      const livekitUrl = new URL(appConfig.livekitUrl);
      if (livekitUrl.protocol === "wss:") {
        livekitUrl.protocol = "https:";
      } else if (livekitUrl.protocol === "ws:") {
        livekitUrl.protocol = "http:";
      }
      const livekitOrigin = livekitUrl.origin;
      if (livekitOrigin.startsWith('https://')) {
        allowedOrigins.push(livekitOrigin);
      }
    } catch {
      // Ignore malformed LiveKit URL in local/dev environments.
    }
  }

  const originList = Array.from(new Set(allowedOrigins)).map((origin) => `"${origin}"`).join(' ');
  return [
    `camera=(self ${originList})`,
    `microphone=(self ${originList})`,
    `display-capture=(self ${originList})`,
    `speaker-selection=(self ${originList})`,
    `fullscreen=(self ${originList})`,
    `autoplay=(self ${originList})`,
  ].join(', ');
};

const addRootSecurityHeaders = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", buildMediaPermissionsPolicy());
  next();
};

class RootApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const requireString = (value: unknown, fieldName: string) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new RootApiError(400, `${fieldName} is required.`);
  }

  return normalized;
};

const requirePositiveNumber = (value: unknown, fieldName: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RootApiError(400, `${fieldName} must be a positive number.`);
  }

  return parsed;
};

const createRazorpayReceipt = (value: string) =>
  String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 40);

const isRazorpayAuthError = (error: any) =>
  Number(error?.statusCode || error?.error?.statusCode || 0) === 401;

const isValidRazorpaySignature = (orderId: string, paymentId: string, signature: string) => {
  const expectedSignature = crypto
    .createHmac("sha256", RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const actualBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
};

const getDiscountedCoursePrice = (course: { price?: number; offerPercentage?: number }) => {
  const basePrice = Math.max(Number(course.price || 0), 0);
  const offerPercentage = Math.min(Math.max(Number(course.offerPercentage || 0), 0), 100);
  const discountedPrice = basePrice * (1 - (offerPercentage / 100));
  return Math.max(Number(discountedPrice.toFixed(2)), 1);
};

const sendRootError = (res: express.Response, error: unknown) => {
  const status = error instanceof RootApiError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Internal server error";
  const requestId = String(res.getHeader("X-Request-Id") || "");

  if (status >= 500) {
    console.error(error);
  }

  return res.status(status).json({
    error: message,
    requestId: requestId || undefined,
  });
};

async function startServer() {
  const diagnostics = getProductionConfigDiagnostics();
  if (diagnostics.errors.length > 0) {
    throw new Error(`Production configuration invalid:\n- ${diagnostics.errors.join("\n- ")}`);
  }

  diagnostics.warnings.forEach((warning: string) => {
    console.warn(`[config] ${warning}`);
  });

  const databaseState = await connectDatabase();
  if (!databaseState.connected && !databaseState.mode) {
    throw new Error("Database initialization failed.");
  }

  if (!databaseState.connected) {
    if (!appConfig.allowMemoryFallback) {
      throw new Error(`Persistent database unavailable: ${databaseState.reason}`);
    }

    console.warn(`Database unavailable, starting in memory mode: ${databaseState.reason}`);
  }

  const enableBackgroundWorkers = String(process.env.ENABLE_BACKGROUND_WORKERS || "true").toLowerCase() !== "false";
  if (enableBackgroundWorkers) {
    startLiveEventBus();
    ensureReplayImporterWorker();
    startMockTestRankingWorker();
    recoverPendingCourseVideoProcessingJobs({ forceRestartRecovery: true })
      .then((result: { scanned: number; scheduled: number }) => {
        console.log(`[video-processing] ${JSON.stringify({
          event: "startup-recovery-complete",
          scannedLessons: result.scanned,
          scheduledJobs: result.scheduled,
          at: new Date().toISOString(),
        })}`);
      })
      .catch((error: unknown) => {
        console.error("[video-processing] failed to recover pending course video jobs", error);
      });
    recoverPendingMockTestRankJobs()
      .then((result: { scanned: number; scheduled: number }) => {
        console.log(`[mock-test-ranking] ${JSON.stringify({
          event: "startup-recovery-complete",
          scannedTests: result.scanned,
          scheduledJobs: result.scheduled,
          at: new Date().toISOString(),
        })}`);
      })
      .catch((error: unknown) => {
        console.error("[mock-test-ranking] failed to recover pending rank jobs", error);
      });
    startVideoProcessingRecoveryLoop();
  }

  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || "0.0.0.0";
  const rootJsonParser = express.json({
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  });

  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use((req, res, next) => {
    const requestId = String(req.headers["x-request-id"] || req.headers["cf-ray"] || crypto.randomUUID());
    res.setHeader("X-Request-Id", requestId);
    next();
  });
  app.use(addRootSecurityHeaders);
  app.use((req, res, next) => {
    if (
      req.path.startsWith("/api/course-manifests/")
      || req.path.startsWith("/backend/api/course-manifests/")
    ) {
      return manifestApp(req, res, next);
    }
    return next();
  });
  app.use("/backend", backendApp);
  app.use("/api", rootJsonParser);

  app.get("/healthz", async (_req, res) => {
    const response = await fetch(`http://127.0.0.1:${PORT}/backend/api/health`).catch(() => null);
    const payload = response ? await response.json() : { status: "unknown" };
    res.json({
      status: "ok",
      app: "frontend-server",
      backend: payload,
      timestamp: new Date().toISOString(),
    });
  });

  const handleRazorpayCreateOrder = async (req: any, res: express.Response) => {
    try {
      if (!razorpay) {
        throw new RootApiError(503, "Razorpay is not configured on this environment.");
      }

      const courseId = requireString(req.body?.courseId, "courseId");
      const requestedCurrency = String(req.body?.currency || "INR").trim().toUpperCase() || "INR";
      const course = await coursesRepository.findById(courseId);

      if (!course) {
        throw new RootApiError(404, "Course not found.");
      }

      const price = requirePositiveNumber(getDiscountedCoursePrice(course), "price");
      const amount = Math.round(price * 100);
      if (amount < 100) {
        throw new RootApiError(400, "Minimum amount is 100 paise.");
      }

      const requestedAmount = req.body?.amount;
      if (requestedAmount !== undefined && requestedAmount !== null) {
        const normalizedRequestedAmount = Number(requestedAmount);
        if (!Number.isFinite(normalizedRequestedAmount) || Math.round(normalizedRequestedAmount) !== amount) {
          throw new RootApiError(400, "Amount does not match the selected course price.");
        }
      }

      const userId = requireString(req.user?.id, "userId");
      const receipt = createRazorpayReceipt(req.body?.receipt || `course-${courseId}-${Date.now()}`);
      const order = await razorpay.orders.create({
        amount,
        currency: requestedCurrency,
        receipt,
        notes: {
          accessType: "course",
          courseId,
          userId,
        },
      });

      const payment = await paymentRepository.createRazorpayCourseOrder({
        userId,
        courseId,
        currency: requestedCurrency,
        receipt,
        origin: String(req.body?.origin || "").trim() || null,
        requestedAmountPaise: Number(req.body?.amount || amount),
        providerOrderId: order.id,
      });

      console.info("[payments] razorpay order created", {
        paymentId: payment._id,
        orderId: order.id,
        courseId,
        userId,
        amount,
      });

      return res.json({
        provider: "razorpay",
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        paymentId: payment._id,
        courseId,
      });
    } catch (error: any) {
      if (isRazorpayAuthError(error)) {
        return res.status(401).json({ error: "Razorpay authentication failed." });
      }

      return sendRootError(res, error);
    }
  };

  const handleRazorpayVerifyPayment = async (req: any, res: express.Response) => {
    try {
      if (!razorpay || !RAZORPAY_KEY_SECRET) {
        throw new RootApiError(503, "Razorpay is not configured on this environment.");
      }

      const courseId = requireString(req.body?.courseId, "courseId");
      const localPaymentId = requireString(req.body?.paymentId, "paymentId");
      const razorpayOrderId = requireString(req.body?.razorpay_order_id || req.body?.order_id, "razorpay_order_id");
      const razorpayPaymentId = requireString(req.body?.razorpay_payment_id || req.body?.payment_id, "razorpay_payment_id");
      const razorpaySignature = requireString(req.body?.razorpay_signature || req.body?.signature, "razorpay_signature");

      if (!isValidRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
        console.warn("[payments] razorpay callback signature failed", {
          paymentId: localPaymentId,
          orderId: razorpayOrderId,
          gatewayPaymentId: razorpayPaymentId,
        });
        throw new RootApiError(400, "Payment signature verification failed.");
      }

      console.info("[payments] razorpay callback received", {
        paymentId: localPaymentId,
        orderId: razorpayOrderId,
        gatewayPaymentId: razorpayPaymentId,
        userId: req.user?.id || null,
      });

      const remotePayment = await razorpay.payments.fetch(razorpayPaymentId);
      const remoteOrderId = String(remotePayment?.order_id || "");
      const remoteStatus = String(remotePayment?.status || "").toLowerCase();
      if (remoteOrderId !== razorpayOrderId) {
        throw new RootApiError(400, "Razorpay payment is linked to a different order.");
      }
      const course = await coursesRepository.findById(courseId);
      if (!course) {
        throw new RootApiError(404, "Course not found.");
      }

      const expectedAmount = Math.round(requirePositiveNumber(getDiscountedCoursePrice(course), "price") * 100);
      if (Number(remotePayment?.amount || 0) !== expectedAmount) {
        throw new RootApiError(400, "Razorpay payment amount does not match the course price.");
      }

      const result = await paymentRepository.markRazorpayCoursePaymentPaid({
        userId: req.user.id,
        paymentId: localPaymentId,
        courseId,
        providerOrderId: razorpayOrderId,
        providerPaymentId: razorpayPaymentId,
        providerSignature: razorpaySignature,
        remoteStatus,
        remoteCreatedAt: remotePayment?.created_at || null,
        remoteMethod: remotePayment?.method || null,
        remoteAcquirerData: remotePayment?.acquirer_data || null,
      });

      console.info("[payments] razorpay callback verified", {
        paymentId: localPaymentId,
        orderId: razorpayOrderId,
        gatewayPaymentId: razorpayPaymentId,
        gatewayStatus: remoteStatus,
        enrollmentActivated: Boolean(result.enrollment),
      });

      return res.json({
        status: result.verificationDecision === "VERIFIED_CAPTURED_ACTIVATED" ? "paid" : "pending",
        enrollment: result.enrollment,
        courseId,
        paymentId: localPaymentId,
        orderId: razorpayOrderId,
        razorpayPaymentId,
        verificationDecision: result.verificationDecision || null,
      });
    } catch (error: any) {
      if (isRazorpayAuthError(error)) {
        return res.status(401).json({ error: "Razorpay authentication failed." });
      }

      return sendRootError(res, error);
    }
  };

  app.post("/api/create-order", requireAuth, handleRazorpayCreateOrder);
  app.post("/api/razorpay/create-order", requireAuth, handleRazorpayCreateOrder);
  app.post("/api/verify-payment", requireAuth, handleRazorpayVerifyPayment);
  app.post("/api/razorpay/verify-payment", requireAuth, handleRazorpayVerifyPayment);
  app.post("/api/razorpay/webhook", async (req: any, res: express.Response) => {
    try {
      const signature = String(req.get("x-razorpay-signature") || "").trim();
      if (signature && req.rawBody?.length) {
        const valid = verifyRazorpayWebhookSignature({
          rawBody: req.rawBody,
          signature,
        });
        if (!valid) {
          console.warn("[payments] razorpay webhook signature failed");
          return res.status(401).json({ error: "Invalid Razorpay webhook signature." });
        }
      }

      console.info("[payments] razorpay webhook received", {
        event: req.body?.event || "payment.updated",
      });

      const result = await paymentRepository.handleWebhook(req.body || {});
      return res.json({
        ok: true,
        webhook: result,
      });
    } catch (error) {
      return sendRootError(res, error);
    }
  });

  app.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({
        error: "Malformed JSON body",
        code: "INVALID_JSON",
        requestId: String(res.getHeader("X-Request-Id") || ""),
      });
    }

    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        error: "Request body is too large",
        code: "PAYLOAD_TOO_LARGE",
        requestId: String(res.getHeader("X-Request-Id") || ""),
      });
    }

    return next(error);
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === "true" ? false : undefined,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = http.createServer(app);

  server.listen(PORT, HOST, () => {
    console.log(
      `Server running on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} (${databaseState.mode})`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

startServer();
