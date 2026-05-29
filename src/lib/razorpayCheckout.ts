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

export const openRazorpayCheckout = (config: RazorpayCheckoutConfig) =>
  new Promise<RazorpaySuccessPayload>((resolve, reject) => {
    if (typeof window === 'undefined' || !window.Razorpay) {
      reject(new Error('Razorpay checkout is not available. Refresh the page and try again.'));
      return;
    }

    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const checkout = new window.Razorpay({
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
  });
