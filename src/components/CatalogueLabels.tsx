import type { Order, OrderItem } from '../../shared/types';

export function CatalogueLabels({ item }: { item: Pick<OrderItem, 'brand' | 'design' | 'color' | 'barcode' | 'sku'> }) {
  const fields = [['Brand', item.brand], ['Design', item.design], ['Colour', item.color], ['Barcode', item.barcode], ['SKU', item.sku]];
  return <dl className="catalogue-labels">{fields.filter(([, value]) => Boolean(value)).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function paymentLabel(order: Order) {
  return `${order.paymentMethod} · ${order.paymentReview ? 'review required' : order.paymentStatus ?? (order.paymentMethod === 'COD' ? 'unpaid' : 'pending')}`;
}

export function PaymentNotice({ order }: { order: Order }) {
  return <div className="payment-notice" role="status"><strong>{paymentLabel(order)}</strong>
    {order.paymentReview ? <p>{order.paymentReview} Do not pay again until the store resolves this review.</p>
      : order.paymentStatus === 'refund_required' ? <p>Refund required — the store must process and verify this manually in the provider dashboard. A cancellation is not a completed refund.</p>
      : order.paymentStatus === 'refunded' ? <p>The server records this payment as refunded.</p>
      : order.paymentMethod === 'Razorpay' ? <p>{order.paymentStatus === 'paid' ? 'Payment verified by the server.' : 'Payment is pending / unpaid, not confirmed. This order is already recorded in your account. Check its status before placing another order.'}</p>
      : <p>{order.status === 'cancelled' ? 'This cash-on-delivery order is cancelled.' : 'Cash on delivery. The order record alone does not confirm payment collection.'}</p>}
  </div>;
}