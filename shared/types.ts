export type Category = 'Shirts' | 'T-Shirts' | 'Trousers' | 'Kurtas' | 'Layers';
export interface Variant { size: string; stock: number; barcode?: string; sku?: string }
export interface Product {
  id: string; slug: string; name: string; category: Category; price: number;
  originalPrice: number | null; color: string; description: string;
  details: string[]; image: string; images: string[]; badge: string | null;
  featured: boolean; active: boolean; variants: Variant[];
  brand?: string; design?: string;
  /** Server-managed availability timestamps; clients cannot write them. */
  soldOutAt?: string | null; archivedAt?: string | null;
}
export interface User { id: string; name: string; email: string; role: 'customer' | 'admin' }
export interface CartItem { productId: string; size: string; quantity: number }
export interface Address { name: string; phone: string; line1: string; city: string; state: string; pincode: string }
export interface OrderItem { productId: string; name: string; image: string; size: string; quantity: number; price: number; color?: string; brand?: string; design?: string; barcode?: string; sku?: string }
export type PaymentStatus = 'unpaid' | 'pending' | 'paid' | 'refund_required' | 'refunded';
export type OrderStatus = 'placed' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';
export interface Order {
  id: string; userId: string; items: OrderItem[]; address: Address; subtotal: number;
  shipping: number; total: number; paymentMethod: 'COD' | 'Razorpay'; status: OrderStatus; createdAt: string;
  paymentStatus?: PaymentStatus; gatewayOrderId?: string | null; paidAt?: string | null;
  paymentReview?: string | null;
}
export interface AdminStats { products: number; orders: number; customers: number; revenue: number }
export interface PaymentConfig { online: boolean; keyId: string | null; mode: 'test' | 'live' | 'disabled'; reason: string; methods: string[] }
export interface OnlineCheckout { order: Order; checkout: { key: string; order_id: string; amount: number; currency: 'INR'; name: string } | null }
export interface ImportPreview { valid: boolean; rows: number; products: number; variants: number; errors: { row: number; message: string }[]; warnings: string[] }
export interface ImageUpload { path: string; bytes: number; width: number; height: number }