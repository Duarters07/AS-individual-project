/**
 * k6 Smoke Test — nopCommerce Observability Verification
 *
 *   Scenario 1 — full_checkout_smoke
 *
 *   Scenario 2 — empty_cart_guard
 *
 * Usage:
 *   k6 run -e TEST_EMAIL=admin@ua.pt -e TEST_PASSWORD=1234 smoke-test.js
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';

// ── Environment config ────────────────────────────────────────────────────────
const BASE_URL      = (__ENV.BASE_URL      || 'http://localhost:5000').replace(/\/$/, '');
const PRODUCT_ID    = parseInt(__ENV.PRODUCT_ID    || '36');
const TEST_EMAIL    = __ENV.TEST_EMAIL    || 'loadtest@test.com';
const TEST_PASSWORD = __ENV.TEST_PASSWORD || 'Test123!';

// ── Options — two named scenarios, sequential ─────────────────────────────────
export const options = {
  scenarios: {
    full_checkout_smoke: {
      executor:  'shared-iterations',
      exec:      'fullCheckoutSmoke',
      vus:       1,
      iterations: 1,
      startTime: '0s',
    },
    empty_cart_guard: {
      executor:  'shared-iterations',
      exec:      'emptyCartGuard',
      vus:       1,
      iterations: 1,
      startTime: '90s',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.05'],
    'checks':          ['rate>0.85'],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractToken(body) {
  let m = body.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (m) return m[1];
  m = body.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/);
  return m ? m[1] : null;
}

function extractFirstRadioValue(body, inputName) {
  const pattern = new RegExp(
    `name=["']${inputName}["'][^>]*value=["']([^"']+)["']`, 'i'
  );
  const m = body.match(pattern);
  return m ? m[1] : null;
}

function doLogin(params) {
  const loginPage = http.get(`${BASE_URL}/login`, params);
  check(loginPage, { 'login page loads': r => r.status === 200 });

  const token = extractToken(loginPage.body);
  if (!token) {
    console.error('[smoke] No anti-forgery token on login page — is the app running?');
    return null;
  }

  const loginRes = http.post(
    `${BASE_URL}/login`,
    {
      Email:                      TEST_EMAIL,
      Password:                   TEST_PASSWORD,
      RememberMe:                 'false',
      __RequestVerificationToken: token,
    },
    params
  );

  const ok = check(loginRes, {
    'login: no error message': r => !r.body.includes('The credentials provided are incorrect'),
    'login: redirected away':  r => !r.url.endsWith('/login'),
  });

  return ok ? (extractToken(loginRes.body) || token) : null;
}

// ── Scenario 1: full_checkout_smoke ───────────────────────────────────────────
export function fullCheckoutSmoke() {
  const params = { redirects: 5 };
  console.log('\n=== SCENARIO: full_checkout_smoke ===');
  console.log(`Target: ${BASE_URL}  |  Product ID: ${PRODUCT_ID}  |  Quantity: 2`);

  // ── Login ──────────────────────────────────────────────────────────────────
  let token = doLogin(params);
  if (!token) {
    console.error('[smoke] Login failed. Aborting.');
    return;
  }
  sleep(0.5);

  // ── Add 2 items to cart ────────────────────────────────────────────────────
  const homePage = http.get(`${BASE_URL}/`, params);
  token = extractToken(homePage.body) || token;

  const addRes = http.post(
    `${BASE_URL}/addproducttocart/catalog/${PRODUCT_ID}/1/2`,
    { __RequestVerificationToken: token },
    { ...params, headers: { 'X-Requested-With': 'XMLHttpRequest' } }
  );

  const cartOk = check(addRes, {
    'add 2 items: 200':     r => r.status === 200,
    'add 2 items: success': r => {
      try { return JSON.parse(r.body).success === true; } catch { return false; }
    },
  });

  if (!cartOk) {
    console.error(`[smoke] Add to cart failed: ${addRes.body.substring(0, 300)}`);
    return;
  }

  // ── Confirm cart and trigger nop.basket.checkout_started ───────────────────
  const cartPage = http.get(`${BASE_URL}/cart`, params);
  check(cartPage, {
    'cart page: 200':   r => r.status === 200,
    'cart: not empty':  r => !r.body.includes('Your Shopping Cart is empty'),
  });

  const cartToken = extractToken(cartPage.body) || token;

  http.post(
    `${BASE_URL}/cart`,
    {
      checkout:                   'checkout',
      checkout_attribute_1:       '1',
      __RequestVerificationToken: cartToken,
    },
    params
  );
  token = cartToken;
  sleep(0.3);

  // ── Billing address ────────────────────────────────────────────────────────
  const billingPage = http.get(`${BASE_URL}/checkout/billingaddress`, params);
  check(billingPage, { 'billing page: 200': r => r.status === 200 });
  if (billingPage.status !== 200) return;

  token = extractToken(billingPage.body) || token;
  const savedAddrMatch = billingPage.body.match(/CheckoutBilling\.editAddress\('[^']+',\s*(\d+)/);

  if (savedAddrMatch) {
    http.post(
      `${BASE_URL}/checkout/selectbillingaddress`,
      { addressId: savedAddrMatch[1], shipToSameAddress: 'true', __RequestVerificationToken: token },
      params
    );
  } else {
    http.post(
      `${BASE_URL}/checkout/billingaddress`,
      {
        'BillingNewAddress.Id':              '0',
        'BillingNewAddress.FirstName':       'Smoke',
        'BillingNewAddress.LastName':        'Test',
        'BillingNewAddress.Email':           TEST_EMAIL,
        'BillingNewAddress.CountryId':       '237',
        'BillingNewAddress.StateProvinceId': '0',
        'BillingNewAddress.City':            'Test City',
        'BillingNewAddress.Address1':        '1 Smoke Test Lane',
        'BillingNewAddress.ZipPostalCode':   '10001',
        'BillingNewAddress.PhoneNumber':     '5550000000',
        ShipToSameAddress:                   'true',
        __RequestVerificationToken:          token,
      },
      params
    );
  }

  // ── Shipping method ────────────────────────────────────────────────────────
  const shippingMethodPage = http.get(`${BASE_URL}/checkout/shippingmethod`, params);
  if (shippingMethodPage.status === 200 && shippingMethodPage.url.includes('shippingmethod')) {
    token = extractToken(shippingMethodPage.body) || token;
    const shippingOption = extractFirstRadioValue(shippingMethodPage.body, 'shippingoption');
    http.post(
      `${BASE_URL}/checkout/shippingmethod`,
      {
        shippingoption:             shippingOption || 'Ground___Shipping.FixedByWeightByTotal',
        nextstep:                   'nextstep',
        __RequestVerificationToken: token,
      },
      params
    );
  }

  // ── Payment method ─────────────────────────────────────────────────────────
  const paymentMethodPage = http.get(`${BASE_URL}/checkout/paymentmethod`, params);
  if (paymentMethodPage.status === 200) {
    token = extractToken(paymentMethodPage.body) || token;
    const paymentMethodValue = extractFirstRadioValue(paymentMethodPage.body, 'paymentmethod') || 'Payments.Manual';
    const pmRes = http.post(
      `${BASE_URL}/checkout/paymentmethod`,
      { paymentmethod: paymentMethodValue, nextstep: 'nextstep', __RequestVerificationToken: token },
      params
    );
    token = extractToken(pmRes.body) || token;
  }

  // ── Payment info ───────────────────────────────────────────────────────────
  const paymentInfoPage = http.get(`${BASE_URL}/checkout/paymentinfo`, params);
  if (paymentInfoPage.status === 200) {
    token = extractToken(paymentInfoPage.body) || token;
    const piRes = http.post(
      `${BASE_URL}/checkout/paymentinfo`,
      {
        CardholderName:             'Smoke Test',
        CardNumber:                 '4111111111111111',
        CardCode:                   '123',
        ExpireMonth:                '12',
        ExpireYear:                 '2030',
        nextstep:                   'nextstep',
        __RequestVerificationToken: token,
      },
      params
    );
    token = extractToken(piRes.body) || token;
  }

  // ── Confirm ────────────────────────────────────────────────────────────────
  const confirmPage = http.get(`${BASE_URL}/checkout/confirm`, params);
  check(confirmPage, { 'confirm page: 200': r => r.status === 200 });
  if (confirmPage.status !== 200) return;

  token = extractToken(confirmPage.body) || token;
  const confirmRes = http.post(
    `${BASE_URL}/checkout/confirm`,
    { nextstep: 'nextstep', __RequestVerificationToken: token },
    params
  );

  const placed = check(confirmRes, {
    'order placed: completed page': r => r.url.includes('/checkout/completed'),
    'order placed: no payment error': r => !r.body.includes('Your credit card has been declined'),
  });

  if (placed) {
    const orderId = confirmRes.url.match(/\/checkout\/completed\/(\d+)/)?.[1] || 'unknown';
    console.log(`\n[smoke] ✓ Order #${orderId} placed successfully.`);
    console.log('\n── What to verify in Jaeger (http://localhost:16686) ──────────────────');
    console.log('  1. Search service "nopCommerce", operation "nop.order.place"');
    console.log('  2. Open the trace. Verify tags on the root span:');
    console.log('       order.success = true');
    console.log('       order.items_count = 2');
    console.log(`       order.id = ${orderId}`);
    console.log('  3. Expand child spans — you must see ALL of:');
    console.log('       nop.payment.process  (payment.status = success)');
    console.log('       db.insert Order      (1×)');
    console.log('       db.insert OrderItem  (2× — one per item)');
    console.log('       nop.inventory.adjust (2× — one per item, inventory.stock_adjusted = true)');
    console.log('       db.delete ShoppingCartItem  (2×)');
    console.log('       event ShoppingCartItemMovedToOrderItemEvent (2×)');
    console.log('       event ClearShoppingCartEvent (1×)');
    console.log('       event OrderPlacedEvent (1×)');
    console.log('\n── What to verify in Grafana (http://localhost:3000) ─────────────────');
    console.log('  Dashboard: nopCommerce → Checkout Business KPIs');
    console.log('  ● "Encomendas com Sucesso" stat: incremented by 1');
    console.log('  ● "Duração do Checkout p50/p95/p99": 1 new observation recorded');
    console.log('  ● "Total de Pagamentos": incremented by 1 (payment_status=success)');
    console.log('  Dashboard: nopCommerce → Inventory');
    console.log('  ● "Ajustes de Inventário por Método": +2 (ManageStock, 1 per item)');
    console.log('  ● "Stock Restante p50/p95/p99": 2 new observations');
  } else {
    console.error(`[smoke] ✗ Order failed. Response URL: ${confirmRes.url}`);
    console.error(`[smoke]   Response body (first 300 chars): ${confirmRes.body.substring(0, 300)}`);
  }
}

// ── Scenario 2: empty_cart_guard ──────────────────────────────────────────────
export function emptyCartGuard() {
  const params = { redirects: 5 };
  console.log('\n=== SCENARIO: empty_cart_guard ===');
  console.log('Testing: Caso C from Basket docs — basket guard stops checkout without an order span');

  const token = doLogin(params);
  if (!token) {
    console.error('[guard] Login failed. Aborting.');
    return;
  }
  sleep(0.5);

  const confirmGet = http.get(`${BASE_URL}/checkout/confirm`, params);

  const guardActivated = check(confirmGet, {
    'empty cart guard: not on /checkout/confirm': r =>
      !r.url.includes('/checkout/confirm'),
    'empty cart guard: redirected to /cart or similar': r =>
      r.url.includes('/cart') || r.url.includes('/login') || r.status === 302,
  });

  if (guardActivated) {
    console.log(`\n[guard] ✓ Guard activated — redirected to: ${confirmGet.url}`);
    console.log('\n── What to verify in Jaeger (http://localhost:16686) ──────────────────');
    console.log('  1. Search service "nopCommerce", operation "HTTP GET /checkout/confirm"');
    console.log('  2. The span exists and completes quickly (< 20ms)');
    console.log('  3. There is NO child span named "nop.order.place" inside it');
    console.log('     → The basket guard in CheckoutController.ConfirmOrder() prevented');
    console.log('       PlaceOrderAsync from being called entirely.');
    console.log('\n── What to verify in Grafana (http://localhost:3000) ─────────────────');
    console.log('  ● "Encomendas com Sucesso" stat: did NOT increment');
    console.log('  ● "nop.order.placed" counter: did NOT increment');
    console.log('  ● "nop.basket.checkout_started" counter: did NOT increment');
    console.log('     (checkout_started only fires on POST /cart, not on GET /checkout/confirm)');
  } else {
    console.warn(`[guard] Cart was NOT empty — URL after confirm attempt: ${confirmGet.url}`);
    console.warn('[guard] To test the guard correctly, ensure no items are in the cart before running.');
    console.warn('[guard] Run: k6 run --vus 1 --iterations 1 smoke-test.js after a clean checkout.');
  }
}
