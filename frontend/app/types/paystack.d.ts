/**
 * app/types/paystack.d.ts
 *
 * TypeScript declarations for @paystack/inline-js.
 * Source: https://paystack.com/docs/payments/accept-payments/
 *
 * The npm package @paystack/inline-js is the bundled equivalent of the
 * Paystack inline script (https://js.paystack.co/v2/inline.js).
 * Import as: import PaystackPop from '@paystack/inline-js';
 */

declare module '@paystack/inline-js' {
  export interface PaystackTransactionSuccess {
    /** Unique transaction reference. */
    reference: string;
    /** Paystack transaction ID. */
    trans: string;
    status: 'success';
    message: string;
    transaction: string;
    trxref: string;
  }

  export interface PaystackTransactionOptions {
    /** Paystack public key — must begin with pk_test_ or pk_live_. */
    key: string;
    /** Customer email address (required by Paystack). */
    email: string;
    /** Amount in kobo (₦1 = 100 kobo). */
    amount: number;
    /** ISO 4217 currency code. Defaults to NGN. */
    currency?: string;
    /** Unique transaction reference. Auto-generated if omitted. */
    ref?: string;
    /** Additional metadata to attach to the transaction. */
    metadata?: Record<string, unknown>;
    /** Called when the customer completes payment. */
    onSuccess?: (transaction: PaystackTransactionSuccess) => void;
    /** Called when the customer closes the payment popup without paying. */
    onCancel?: () => void;
    /** Called when the popup has loaded and is ready. */
    onLoad?: (response: { id: number }) => void;
    /** Called when an error prevents the transaction from loading. */
    onError?: (error: { message: string }) => void;
  }

  interface IPaystackPop {
    /**
     * Open the Paystack inline payment popup.
     * Must be called within a user gesture handler (onClick / onTouchEnd).
     */
    newTransaction(options: PaystackTransactionOptions): void;
    /** Resume a transaction from an existing access code. */
    resumeTransaction(accessCode: string): void;
    /** Programmatically cancel an open transaction by ID. */
    cancelTransaction(transactionId: number): void;
  }

  const PaystackPop: IPaystackPop;
  export default PaystackPop;
}
