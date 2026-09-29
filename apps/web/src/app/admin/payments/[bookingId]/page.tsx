import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import type { Prisma } from '@/generated/prisma/client';
import { PaymentError } from '@/features/payments/errors';
import { bookingIdParamSchema } from '@/features/payments/schemas';
import {
  getBookingPaymentSummaryForStaff,
  getPaymentBookingHeaderForActor,
} from '@/features/payments/service';

import {
  BOOKING_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  PLAN_STATUS_LABELS,
} from '../_components/labels';
import styles from '../payments.module.css';
import { AmountForm } from './_components/AmountForm';
import { PaymentAction } from './_components/PaymentAction';
import { FinancialsForm } from './_components/FinancialsForm';
import { ProposePlanForm } from './_components/ProposePlanForm';
import { SectionFeedback } from './_components/SectionFeedback';

const ALLOWED_ROLES: readonly AppRole[] = [
  'ADMIN_MANAGER',
  'TRAVEL_CONSULTANT',
  'FINANCE_ACCOUNTING',
];

type PageParams = Promise<{ bookingId: string }>;

function money(value: Prisma.Decimal | null, currencyCode: string | null): string {
  if (value === null) return 'Not set';
  return `${currencyCode ?? ''} ${value.toFixed(2)}`.trim();
}

function calendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function NotFound({ message }: { message: string }) {
  return (
    <div>
      <Link href="/admin/payments">← Back to Payments</Link>
      <h1>Booking not found</h1>
      <p>{message}</p>
    </div>
  );
}

/**
 * The staff payments view for one Booking (D-054 §6 Stage 3). A Server
 * Component: it authenticates, validates the route id, reads the Booking
 * header through `getPaymentBookingHeaderForActor`, and only after that
 * succeeds reads `getBookingPaymentSummaryForStaff` — both actor-scoped, so
 * an unassigned Travel Consultant or Finance/Accounting user sees the same
 * "not found" state for a missing and an unassigned Booking.
 *
 * Controls follow D-054 §3 and D-057: the Travel Consultant proposes a plan
 * and may withdraw an unapproved one; Finance/Accounting approves or
 * withdraws plans, records, confirms, reverses, and refunds payments,
 * issues receipts, and allocates; Admin/Manager is read-only. Showing a
 * control is only a convenience — every rule (status, locks, amounts,
 * cancelled Bookings, races) is decided by the service when it is used.
 */
export default async function AdminPaymentDetailPage({ params }: { params: PageParams }) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const access = authorize(user.role, ALLOWED_ROLES);
  if (!access.authorized) {
    return (
      <div>
        <h1>Access denied</h1>
        <p>
          Only Admin/Manager, Travel Consultant, and Finance/Accounting staff can access payments.
        </p>
      </div>
    );
  }

  const idResult = bookingIdParamSchema.safeParse(await params);
  if (!idResult.success) {
    return <NotFound message="This booking link is invalid." />;
  }
  const bookingId = idResult.data.bookingId;

  let header;
  try {
    header = await getPaymentBookingHeaderForActor(user, bookingId);
  } catch (error) {
    if (
      error instanceof PaymentError &&
      (error.code === 'BOOKING_NOT_FOUND' || error.code === 'BOOKING_FORBIDDEN')
    ) {
      return <NotFound message="This booking was not found or is not accessible to you." />;
    }
    throw error;
  }

  // Sequenced strictly after the actor-scoped header read above.
  const summary = await getBookingPaymentSummaryForStaff(user, header.id);

  const isConsultant = user.role === 'TRAVEL_CONSULTANT';
  const isFinance = user.role === 'FINANCE_ACCOUNTING';
  const currency = summary.currencyCode;
  const plan = summary.activePlan;
  const confirmedPayments = summary.payments.filter((payment) => payment.status === 'CONFIRMED');

  return (
    <div>
      <Link href="/admin/payments">← Back to Payments</Link>
      <h1>{header.bookingReference}</h1>

      {header.status === 'CANCELLED' ? (
        <p className={styles.notice} role="note">
          This booking is cancelled. New plans, approvals, allocations, and new or confirmed
          payments are not permitted; reversals, refunds, receipts, and plan withdrawal remain
          available.
        </p>
      ) : null}

      <dl className={styles.detailFields}>
        <div className={styles.detailField}>
          <dt>Client</dt>
          <dd>{header.client.fullName}</dd>
        </div>
        <div className={styles.detailField}>
          <dt>Booking status</dt>
          <dd>{BOOKING_STATUS_LABELS[header.status]}</dd>
        </div>
        <div className={styles.detailField}>
          <dt>Booking total</dt>
          <dd>{money(summary.totalAmount, currency)}</dd>
        </div>
        <div className={styles.detailField}>
          <dt>Confirmed amount paid</dt>
          <dd>{money(summary.confirmedAmountPaid, currency)}</dd>
        </div>
        <div className={styles.detailField}>
          <dt>Remaining balance</dt>
          <dd>{money(summary.remainingBalance, currency)}</dd>
        </div>
        <div className={styles.detailField}>
          <dt>Next payment due</dt>
          <dd>{summary.nextPaymentDue ? calendarDate(summary.nextPaymentDue) : 'None'}</dd>
        </div>
        {summary.overpayment && summary.overpayment.greaterThan(0) ? (
          <div className={styles.detailField}>
            <dt>Overpayment</dt>
            <dd>{money(summary.overpayment, currency)}</dd>
          </div>
        ) : null}
        <div className={styles.detailField}>
          <dt>Unapplied credit</dt>
          <dd>{money(summary.unappliedCredit, currency)}</dd>
        </div>
      </dl>

      {isFinance ? (
        <section className={styles.section} aria-labelledby="financials-heading">
          <h2 id="financials-heading">Booking financials</h2>
          <FinancialsForm
            bookingId={header.id}
            currentTotal={summary.totalAmount ? summary.totalAmount.toFixed(2) : null}
            currentCurrency={currency}
          />
        </section>
      ) : summary.totalAmount === null ? (
        <p className={styles.notice} role="note">
          The booking total and currency are not set yet, so no payment plan can be proposed and no
          payment can be recorded. The Booking&apos;s assigned Finance/Accounting user sets them
          here.
        </p>
      ) : null}

      <section className={styles.section} aria-labelledby="payment-plan-heading">
        <h2 id="payment-plan-heading">Payment plan</h2>
        <SectionFeedback>
          {plan ? (
            <p>
              Status:{' '}
              <strong>{PLAN_STATUS_LABELS[plan.status as keyof typeof PLAN_STATUS_LABELS]}</strong>
            </p>
          ) : (
            <p>No active payment plan.</p>
          )}

          {summary.installments.length > 0 ? (
            <ol className={styles.itemList}>
              {summary.installments.map((installment, index) => (
                <li key={installment.id} className={styles.item}>
                  <dl className={styles.itemFields}>
                    <div>
                      <dt>Installment</dt>
                      <dd>{index + 1}</dd>
                    </div>
                    <div>
                      <dt>Due</dt>
                      <dd>{calendarDate(installment.dueDate)}</dd>
                    </div>
                    <div>
                      <dt>Amount</dt>
                      <dd>{money(installment.amount, currency)}</dd>
                    </div>
                    <div>
                      <dt>Outstanding</dt>
                      <dd>{money(installment.outstandingAmount, currency)}</dd>
                    </div>
                  </dl>
                  {installment.allocations.length > 0 ? (
                    <ul className={styles.itemList}>
                      {installment.allocations.map((allocation) => (
                        <li key={allocation.id}>
                          Allocated {money(allocation.amount, currency)}
                          {allocation.refundedAmount.greaterThan(0)
                            ? ` (refunded ${money(allocation.refundedAmount, currency)})`
                            : ''}
                          {allocation.isReversed ? ' — reversed' : ''}
                          {isFinance && !allocation.isReversed ? (
                            <PaymentAction
                              label="Reverse allocation…"
                              submitLabel="Reverse allocation"
                              url={`/api/payments/allocations/${allocation.id}/reversal`}
                              withReason
                              idempotent
                              warning="Reversing returns this amount to the installment's outstanding balance. It cannot be undone."
                              successMessage="Allocation reversed."
                            />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}

          {plan?.status === 'PROPOSED' && isFinance ? (
            <PaymentAction
              label="Approve plan…"
              submitLabel="Approve plan"
              url={`/api/payments/plans/${plan.id}/approval`}
              warning="Approving makes this plan visible to the client and locks the booking total. An approved plan cannot be withdrawn."
              successMessage="Payment plan approved."
            />
          ) : null}
          {plan?.status === 'PROPOSED' && (isFinance || isConsultant) ? (
            <PaymentAction
              label="Withdraw plan…"
              submitLabel="Withdraw plan"
              url={`/api/payments/plans/${plan.id}/withdrawal`}
              withReason
              warning="Withdrawing keeps this plan as history and lets a corrected plan be proposed. It cannot be undone."
              successMessage="Payment plan withdrawn."
            />
          ) : null}
          {!plan && isConsultant && summary.totalAmount !== null && currency ? (
            <ProposePlanForm bookingId={header.id} currencyCode={currency} />
          ) : null}
        </SectionFeedback>
      </section>

      <section className={styles.section} aria-labelledby="payments-heading">
        <h2 id="payments-heading">Payments</h2>
        <SectionFeedback>
          {summary.payments.length === 0 ? (
            <p>No payments have been recorded for this booking.</p>
          ) : (
            <ul className={styles.itemList}>
              {summary.payments.map((payment) => {
                const refundableAllocations = summary.installments.flatMap((installment, index) =>
                  installment.allocations
                    .filter(
                      (allocation) => allocation.paymentId === payment.id && !allocation.isReversed,
                    )
                    .map((allocation) => ({
                      value: allocation.id,
                      label: `Installment ${index + 1}: ${money(allocation.amount, currency)}`,
                    })),
                );
                return (
                  <li key={payment.id} className={styles.item}>
                    <dl className={styles.itemFields}>
                      <div>
                        <dt>Amount</dt>
                        <dd>{money(payment.amount, currency)}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{PAYMENT_STATUS_LABELS[payment.status]}</dd>
                      </div>
                      <div>
                        <dt>Receipt</dt>
                        <dd>{payment.receipt ? payment.receipt.receiptNumber : 'None'}</dd>
                      </div>
                    </dl>
                    {isFinance && payment.status === 'PENDING' ? (
                      <PaymentAction
                        label="Confirm payment…"
                        submitLabel="Confirm payment"
                        url={`/api/payments/${payment.id}/confirmation`}
                        withReason
                        idempotent
                        successMessage="Payment confirmed."
                      />
                    ) : null}
                    {isFinance && payment.status === 'CONFIRMED' && !payment.receipt ? (
                      <PaymentAction
                        label="Issue receipt…"
                        submitLabel="Issue receipt"
                        url={`/api/payments/${payment.id}/receipt`}
                        successMessage="Receipt issued."
                      />
                    ) : null}
                    {isFinance && payment.status === 'CONFIRMED' ? (
                      <>
                        <PaymentAction
                          label="Reverse payment…"
                          submitLabel="Reverse payment"
                          url={`/api/payments/${payment.id}/reversal`}
                          withReason
                          idempotent
                          warning="Reversing removes this payment from the confirmed amount paid. It cannot be undone."
                          successMessage="Payment reversed."
                        />
                        <AmountForm
                          title="Refund this payment"
                          submitLabel="Record refund"
                          url={`/api/payments/${payment.id}/refunds`}
                          selects={
                            refundableAllocations.length > 0
                              ? [
                                  {
                                    name: 'allocationId',
                                    label: 'Reduce allocation',
                                    optionalLabel: 'None — refund unapplied credit',
                                    options: refundableAllocations,
                                  },
                                ]
                              : []
                          }
                          withReason
                          warning="A refund cannot be undone. Record it only once the money has been returned."
                          successMessage="Refund recorded."
                          currencyCode={currency ?? ''}
                        />
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {isFinance && currency ? (
            <AmountForm
              title="Record a payment received"
              submitLabel="Record payment"
              url="/api/payments"
              fixed={{ bookingId: header.id }}
              successMessage="Payment recorded as pending. Confirm it once the funds are verified."
              currencyCode={currency}
            />
          ) : null}

          {isFinance &&
          plan?.status === 'APPROVED' &&
          confirmedPayments.length > 0 &&
          summary.installments.length > 0 ? (
            <AmountForm
              title="Allocate a payment to an installment"
              submitLabel="Allocate"
              url="/api/payments/allocations"
              selects={[
                {
                  name: 'paymentId',
                  label: 'Payment',
                  options: confirmedPayments.map((payment) => ({
                    value: payment.id,
                    label: `${money(payment.amount, currency)}${payment.receipt ? ` (receipt ${payment.receipt.receiptNumber})` : ''}`,
                  })),
                },
                {
                  name: 'installmentId',
                  label: 'Installment',
                  options: summary.installments.map((installment, index) => ({
                    value: installment.id,
                    label: `Installment ${index + 1}, due ${calendarDate(installment.dueDate)} — outstanding ${money(installment.outstandingAmount, currency)}`,
                  })),
                },
              ]}
              successMessage="Allocation recorded."
              currencyCode={currency ?? ''}
            />
          ) : null}
        </SectionFeedback>
      </section>
    </div>
  );
}
