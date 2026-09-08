import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Product } from '../../shared/types';
import { CART_LIMIT_MESSAGE, CART_MAX_LINES, CART_MAX_QUANTITY, useStore } from '../context/Store';

/** Explicit size choice; reuse the store's synchronous cart/stock validation. */
export function CardPurchaseActions({ product }: { product: Product }) {
  const { addItem, cart, setBagOpen } = useStore();
  const navigate = useNavigate();
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);
  const [size, setSize] = useState('');
  const [error, setError] = useState('');
  const available = product.active && product.variants.some(v => v.stock > 0);
  const variant = product.variants.find(v => v.size === size);
  const inBag = cart.find(item => item.productId === product.id && item.size === size)?.quantity ?? 0;
  const limitError = !size ? ''
    : cart.length > CART_MAX_LINES || (!inBag && cart.length >= CART_MAX_LINES) || inBag >= CART_MAX_QUANTITY ? CART_LIMIT_MESSAGE
    : !variant || variant.stock <= 0 ? 'This size is unavailable. Choose another size.'
    : inBag >= variant.stock ? 'All available units of this size are already in your bag.' : '';
  const feedback = error || limitError;

  function purchase(buyNow: boolean) {
    if (!size) {
      setError('Choose an available size first.');
      select.current?.focus();
      return;
    }
    if (!available || limitError) { setError(limitError || 'This piece is unavailable.'); return; }
    if (!addItem(product, size, 1)) {
      setError('Could not add this size. Review your bag and current availability.');
      return;
    }
    setError('');
    if (buyNow) {
      // React batches this with addItem's bag-open update: no competing dialogs.
      // Keep existing bag items; never silently replace the customer's selection.
      setBagOpen(false);
      navigate('/checkout');
    }
  }

  return <div className="product-card-actions">
    <label htmlFor={`${id}-size`}>Size
      <select ref={select} id={`${id}-size`} aria-label={`Size for ${product.name}`} value={size}
        disabled={!available} aria-invalid={Boolean(feedback)} aria-describedby={feedback ? `${id}-error` : undefined}
        onChange={event => { setSize(event.target.value); setError(''); }}>
        <option value="">{available ? 'Choose size' : 'Sold out'}</option>
        {product.variants.map(v => <option key={v.size} value={v.size} disabled={v.stock <= 0}>
          {v.size}{v.stock <= 0 ? ' — sold out' : ''}
        </option>)}
      </select>
    </label>
    {feedback && <p id={`${id}-error`} className="field-error" role="alert">{feedback}</p>}
    <div className="product-card-actions__buttons">
      <button type="button" className="button" disabled={!available || Boolean(limitError)}
        aria-label={`${available ? 'Add to bag' : 'Sold out'}: ${product.name}`} onClick={() => purchase(false)}>
        {available ? 'Add to bag' : 'Sold out'}
      </button>
      <button type="button" className="button outline-button" disabled={!available || Boolean(limitError)}
        aria-label={`Buy now: ${product.name}`} aria-describedby={`${id}-buy-help`} onClick={() => purchase(true)}>Buy now</button>
    </div>
    <span id={`${id}-buy-help`} className="sr-only">Adds one in your chosen size and opens checkout with your existing bag items.</span>
  </div>;
}