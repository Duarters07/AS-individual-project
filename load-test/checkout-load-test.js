/**
 * k6 Load Test — nopCommerce Checkout Flow
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// ── Custom k6 metrics (complement the OTel metrics in Grafana) ────────────────
const ordersCompleted  = new Counter('orders_completed');
const ordersFailed     = new Counter('orders_failed');
const checkoutDuration = new Trend('checkout_e2e_duration_ms', true);
const cartSuccessRate  = new Rate('cart_add_success_rate');

// ── Environment config ────────────────────────────────────────────────────────
const BASE_URL      = (__ENV.BASE_URL      || 'http://localhost:5000').replace(/\/$/, '');
const PRODUCT_ID    = parseInt(__ENV.PRODUCT_ID    || '36');  // Use a product without required attributes
const TEST_EMAIL    = __ENV.TEST_EMAIL    || 'loadtest@test.com';
const TEST_PASSWORD = __ENV.TEST_PASSWORD || 'Test123!';

// ── Load profile ──────────────────────────────────────────────────────────────
export const options = {
  stages: [
    { duration: '30s', target: 5  },
    { duration: '60s', target: 5  },
    { duration: '20s', target: 20 },
    { duration: '90s', target: 20 },
    { duration: '30s', target: 0  },
  ],
  thresholds: {
    'http_req_failed':       ['rate<0.05'],
    'checks':                ['rate>0.90'],
    'http_req_duration':     ['p(95)<5000'],
    'orders_completed':      ['count>10'],
    'cart_add_success_rate': ['rate>0.90'],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractToken(body) {
  let m = body.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (m) return m[1];
  m = body.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/);
  if (m) return m[1];
  return null;
}

function extractFirstSelectValue(body, selectName) {
  const pattern = new RegExp(
    `name=["']${selectName}["'][\\s\\S]{0,300}?<option[^>]+value=["']([^"']+)["']`,
    'i'
  );
  const m = body.match(pattern);
  return m ? m[1] : null;
}

function extractFirstRadioValue(body, inputName) {
  const pattern = new RegExp(
    `name=["']${inputName}["'][^>]*value=["']([^"']+)["']`,
    'i'
  );
  const m = body.match(pattern);
  return m ? m[1] : null;
}

function extractOrderId(url, body) {
  const urlMatch = url.match(/\/checkout\/completed\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  const bodyMatch = body.match(/order(?:Id|Number)[^>]*>(\d+)</i);
  return bodyMatch ? bodyMatch[1] : 'unknown';
}

// ── Main VU scenario ──────────────────────────────────────────────────────────
export default function () {
  const params = { redirects: 5 };

  // ── Step 1: Login ───────────────────────────────────────────────────────────
  let token;
  group('login', () => {
    const loginPage = http.get(`${BASE_URL}/login`, params);
    check(loginPage, { 'login page: 200': r => r.status === 200 });

    token = extractToken(loginPage.body);
    if (!token) {
      console.error(`[VU ${__VU}] No token found on login page`);
      return;
    }

    const loginRes = http.post(
      `${BASE_URL}/login`,
      {
        Email:                        TEST_EMAIL,
        Password:                     TEST_PASSWORD,
        RememberMe:                   'false',
        __RequestVerificationToken:   token,
      },
      { ...params, tags: { group: 'login' } }
    );

    check(loginRes, {
      'login: not on error':   r => !r.body.includes('The credentials provided are incorrect'),
      'login: redirected away from /login': r => !r.url.endsWith('/login'),
    });
  });

  sleep(0.5);

  // ── Step 2: Add product to cart ─────────────────────────────────────────────
  let cartOk = false;
  group('add_to_cart', () => {
    const homePage = http.get(`${BASE_URL}/`, params);
    token = extractToken(homePage.body) || token;

    const addRes = http.post(
      `${BASE_URL}/addproducttocart/catalog/${PRODUCT_ID}/1/2`,
      { __RequestVerificationToken: token },
      {
        ...params,
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        tags: { group: 'add_to_cart' },
      }
    );

    cartOk = check(addRes, {
      'add to cart: 200':     r => r.status === 200,
      'add to cart: success': r => {
        try { return JSON.parse(r.body).success === true; } catch { return false; }
      },
    });
    cartSuccessRate.add(cartOk ? 1 : 0);

    if (!cartOk) {
      console.warn(`[VU ${__VU}] Add to cart failed: ${addRes.body.substring(0, 200)}`);
      return;
    }

    const cartPage = http.get(`${BASE_URL}/cart`, params);
    check(cartPage, {
      'cart page: 200':     r => r.status === 200,
      'cart: not empty':    r => !r.body.includes('Your Shopping Cart is empty'),
    });

    const cartToken = extractToken(cartPage.body) || token;
    http.post(
      `${BASE_URL}/cart`,
      {
        checkout:                   'checkout',
        checkout_attribute_1:       '1',
        __RequestVerificationToken: cartToken,
      },
      { ...params, tags: { group: 'add_to_cart' } }
    );
    token = cartToken;
  });

  if (!cartOk) {
    ordersFailed.add(1);
    sleep(2);
    return;
  }

  sleep(0.5);

  // ── Step 3: Full checkout flow ──────────────────────────────────────────────
  const checkoutStart = Date.now();
  let orderPlaced = false;

  group('checkout_flow', () => {

    // 3a. Billing Address ─────────────────────────────────────────────────────
    const billingPage = http.get(
      `${BASE_URL}/checkout/billingaddress`,
      { ...params, tags: { group: 'checkout_flow' } }
    );
    check(billingPage, { 'billing page: 200': r => r.status === 200 });
    if (billingPage.status !== 200) return;

    token = extractToken(billingPage.body);

    const savedAddrMatch = billingPage.body.match(/CheckoutBilling\.editAddress\('[^']+',\s*(\d+)/);
    const savedBillingId = savedAddrMatch ? savedAddrMatch[1] : null;

    let billingRes;
    if (savedBillingId) {
      billingRes = http.post(
        `${BASE_URL}/checkout/selectbillingaddress`,
        { addressId: savedBillingId, shipToSameAddress: 'true', __RequestVerificationToken: token },
        { ...params, tags: { group: 'checkout_flow' } }
      );
    } else {
      billingRes = http.post(
        `${BASE_URL}/checkout/billingaddress`,
        {
          'BillingNewAddress.Id':             '0',
          'BillingNewAddress.FirstName':      'Load',
          'BillingNewAddress.LastName':       'Test',
          'BillingNewAddress.Email':          TEST_EMAIL,
          'BillingNewAddress.CountryId':      '237',
          'BillingNewAddress.StateProvinceId': '0',
          'BillingNewAddress.City':           'Test City',
          'BillingNewAddress.Address1':       '123 Load Test Street',
          'BillingNewAddress.ZipPostalCode':  '10001',
          'BillingNewAddress.PhoneNumber':    '5550000000',
          'ShipToSameAddress':                'true',
          __RequestVerificationToken:         token,
        },
        { ...params, tags: { group: 'checkout_flow' } }
      );
    }
    check(billingRes, { 'billing: accepted': r => r.status === 200 || r.status === 302 });

    // 3b. Shipping Address ────────────────────────────────────────────────────
    const shippingAddrPage = http.get(
      `${BASE_URL}/checkout/shippingaddress`,
      { ...params, tags: { group: 'checkout_flow' } }
    );
    if (shippingAddrPage.status === 200 && shippingAddrPage.url.includes('shippingaddress')) {
      token = extractToken(shippingAddrPage.body) || token;

      const savedShipMatch = shippingAddrPage.body.match(/CheckoutShipping\.editAddress\('[^']+',\s*(\d+)/);
      const savedShippingId = savedShipMatch ? savedShipMatch[1] : null;

      let shippingAddrRes;
      if (savedShippingId) {
        shippingAddrRes = http.post(
          `${BASE_URL}/checkout/selectshippingaddress`,
          { addressId: savedShippingId, __RequestVerificationToken: token },
          { ...params, tags: { group: 'checkout_flow' } }
        );
      } else {
        const shippingCountryId = extractFirstSelectValue(shippingAddrPage.body, 'ShippingNewAddress.CountryId') || '237';
        shippingAddrRes = http.post(
          `${BASE_URL}/checkout/shippingaddress`,
          {
            'ShippingNewAddress.Id':          '0',
            'ShippingNewAddress.FirstName':   'Load',
            'ShippingNewAddress.LastName':    'Test',
            'ShippingNewAddress.Email':       TEST_EMAIL,
            'ShippingNewAddress.CountryId':   shippingCountryId,
            'ShippingNewAddress.StateProvinceId': '0',
            'ShippingNewAddress.City':        'Test City',
            'ShippingNewAddress.Address1':    '123 Load Test Street',
            'ShippingNewAddress.ZipPostalCode': '10001',
            'ShippingNewAddress.PhoneNumber': '5550000000',
            __RequestVerificationToken:        token,
          },
          { ...params, tags: { group: 'checkout_flow' } }
        );
      }
      check(shippingAddrRes, { 'shipping address: accepted': r => r.status === 200 || r.status === 302 });
    }

    // 3c. Shipping Method ─────────────────────────────────────────────────────
    const shippingMethodPage = http.get(
      `${BASE_URL}/checkout/shippingmethod`,
      { ...params, tags: { group: 'checkout_flow' } }
    );
    if (shippingMethodPage.status === 200 && shippingMethodPage.url.includes('shippingmethod')) {
      token = extractToken(shippingMethodPage.body) || token;
      const shippingOption = extractFirstRadioValue(shippingMethodPage.body, 'shippingoption');

      const shippingMethodRes = http.post(
        `${BASE_URL}/checkout/shippingmethod`,
        {
          shippingoption:               shippingOption || 'Ground___Shipping.FixedByWeightByTotal',
          nextstep:                     'nextstep',
          __RequestVerificationToken:   token,
        },
        { ...params, tags: { group: 'checkout_flow' } }
      );
      check(shippingMethodRes, { 'shipping method: accepted': r => r.status === 200 || r.status === 302 });
    }

    // 3d. Payment Method ──────────────────────────────────────────────────────
    const paymentMethodPage = http.get(
      `${BASE_URL}/checkout/paymentmethod`,
      { ...params, tags: { group: 'checkout_flow' } }
    );
    if (paymentMethodPage.status === 200) {
      token = extractToken(paymentMethodPage.body) || token;
      const paymentMethodValue = extractFirstRadioValue(paymentMethodPage.body, 'paymentmethod') || 'Payments.Manual';
      console.log(`[VU ${__VU}] Payment method selected: ${paymentMethodValue}`);
      const paymentMethodRes = http.post(
        `${BASE_URL}/checkout/paymentmethod`,
        {
          paymentmethod:              paymentMethodValue,
          nextstep:                   'nextstep',
          __RequestVerificationToken: token,
        },
        { ...params, tags: { group: 'checkout_flow' } }
      );
      check(paymentMethodRes, { 'payment method: accepted': r => r.status === 200 || r.status === 302 });
      token = extractToken(paymentMethodRes.body) || token;
    }

    // 3e. Payment Info ────────────────────────────────────────────────────────
    const paymentInfoPage = http.get(
      `${BASE_URL}/checkout/paymentinfo`,
      { ...params, tags: { group: 'checkout_flow' } }
    );
    console.log(`[VU ${__VU}] Payment info page URL: ${paymentInfoPage.url} (${paymentInfoPage.status})`);
    if (paymentInfoPage.status === 200) {
      token = extractToken(paymentInfoPage.body) || token;
      const paymentInfoRes = http.post(
        `${BASE_URL}/checkout/paymentinfo`,
        {
          CardholderName:             'Load Test',
          CardNumber:                 '4111111111111111',
          CardCode:                   '123',
          ExpireMonth:                '12',
          ExpireYear:                 '2030',
          nextstep:                   'nextstep',
          __RequestVerificationToken: token,
        },
        { ...params, tags: { group: 'checkout_flow' } }
      );
      check(paymentInfoRes, { 'payment info: accepted': r => r.status === 200 || r.status === 302 });
      token = extractToken(paymentInfoRes.body) || token;
      console.log(`[VU ${__VU}] Payment info POST → ${paymentInfoRes.url} (${paymentInfoRes.status})`);
    }

    // 3f. Confirm Order ───────────────────────────────────────────────────────
    const confirmPage = http.get(
      `${BASE_URL}/checkout/confirm`,
      { ...params, tags: { group: 'checkout_flow' } }
    );
    check(confirmPage, { 'confirm page: 200': r => r.status === 200 });
    if (confirmPage.status !== 200) return;

    token = extractToken(confirmPage.body) || token;

    const confirmRes = http.post(
      `${BASE_URL}/checkout/confirm`,
      { nextstep: 'nextstep', __RequestVerificationToken: token },
      { ...params, tags: { group: 'checkout_flow' } }
    );

    orderPlaced = check(confirmRes, {
      'order confirm: redirected to completed': r =>
        r.url.includes('/checkout/completed') || r.status === 302,
      'order confirm: no payment decline':      r =>
        !r.body.includes('Your credit card has been declined'),
      'order confirm: no system error':         r =>
        !r.body.includes('An error occurred processing your order'),
    });

    if (orderPlaced) {
      const orderId = extractOrderId(confirmRes.url, confirmRes.body);
      console.log(`[VU ${__VU}] Order placed: #${orderId}`);
    } else {
      console.warn(`[VU ${__VU}] Order failed. Response URL: ${confirmRes.url}`);
    }
  });

  const elapsed = Date.now() - checkoutStart;
  checkoutDuration.add(elapsed);

  if (orderPlaced) {
    ordersCompleted.add(1);
  } else {
    ordersFailed.add(1);
  }

  sleep(2);
}

// ── Smoke test helper (run once to verify setup) ──────────────────────────────
export function setup() {
  console.log(`=== Load Test Setup ===`);
  console.log(`Target:     ${BASE_URL}`);
  console.log(`Product ID: ${PRODUCT_ID}`);
  console.log(`Test user:  ${TEST_EMAIL}`);

  const res = http.get(`${BASE_URL}/`, { redirects: 3 });
  if (res.status !== 200) {
    console.error(`[SETUP] Cannot reach ${BASE_URL} — got HTTP ${res.status}`);
  } else {
    console.log(`[SETUP] Site reachable. Ready to run.`);
  }
}
