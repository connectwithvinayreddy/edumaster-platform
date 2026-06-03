type RazorpaySuccessPayload = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

type RazorpayCheckoutConfig = {
  amount: number;
  courseId: string;
  courseTitle: string;
  currency: string;
  key: string;
  orderId: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string | null;
  };
};

type RazorpayInstance = {
  on: (event: 'payment.failed', handler: (payload: { error?: { description?: string } }) => void) => void;
  open: () => void;
};

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

const RAZORPAY_CHECKOUT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
const RAZORPAY_SCRIPT_TIMEOUT_MS = 15_000;
let razorpayScriptPromise: Promise<RazorpayConstructor> | null = null;

const readRazorpayConstructor = () =>
  typeof window !== 'undefined' && window.Razorpay ? window.Razorpay : null;

const ensureRazorpayCheckoutLoaded = async () => {
  const existingConstructor = readRazorpayConstructor();
  if (existingConstructor) {
    return existingConstructor;
  }

  if (typeof document === 'undefined') {
    throw new Error('Razorpay checkout is not available in this environment.');
  }

  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise<RazorpayConstructor>((resolve, reject) => {
      const existingScript = document.querySelector(`script[src="${RAZORPAY_CHECKOUT_URL}"]`) as HTMLScriptElement | null;
      const script = existingScript || document.createElement('script');
      let resolved = false;
      let timeoutId: number | null = null;

      const finish = (callback: () => void) => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        callback();
      };

      const resolveIfReady = () => {
        const constructor = readRazorpayConstructor();
        if (constructor) {
          finish(() => resolve(constructor));
        }
      };

      script.async = true;
      script.src = RAZORPAY_CHECKOUT_URL;
      script.onload = () => resolveIfReady();
      script.onerror = () => finish(() => reject(new Error('Unable to load Razorpay checkout right now.')));

      timeoutId = window.setTimeout(() => {
        finish(() => reject(new Error('Razorpay checkout took too long to load. Please try again.')));
      }, RAZORPAY_SCRIPT_TIMEOUT_MS);

      if (!existingScript) {
        document.body.appendChild(script);
      } else {
        resolveIfReady();
      }
    }).catch((error) => {
      razorpayScriptPromise = null;
      throw error;
    });
  }

  return razorpayScriptPromise;
};

export const openRazorpayCheckout = (config: RazorpayCheckoutConfig) =>
  new Promise<RazorpaySuccessPayload>((resolve, reject) => {
    void ensureRazorpayCheckoutLoaded().then((RazorpayCheckout) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        callback();
      };

      const checkout = new RazorpayCheckout({
        key: config.key,
        amount: config.amount,
        currency: config.currency,
        name: 'VaronEnglish',
        description: `Enrollment for ${config.courseTitle}`,
        order_id: config.orderId,
        handler: (response: RazorpaySuccessPayload) => {
          finish(() => resolve(response));
        },
        modal: {
          ondismiss: () => {
            finish(() => reject(new Error('Payment was cancelled before completion.')));
          },
        },
        notes: {
          courseId: config.courseId,
        },
        prefill: {
          name: config.prefill?.name || '',
          email: config.prefill?.email || '',
          contact: config.prefill?.contact || '',
        },
        theme: {
          color: '#2f6fe4',
        },
      });

      checkout.on('payment.failed', (payload) => {
        const message = payload?.error?.description || 'Razorpay reported that the payment failed.';
        finish(() => reject(new Error(message)));
      });

      try {
        checkout.open();
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error('Unable to open Razorpay checkout.')));
      }
    }).catch((error) => {
      reject(error instanceof Error ? error : new Error('Razorpay checkout is not available. Refresh the page and try again.'));
    });
  });
