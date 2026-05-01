---
title: "How I Reverse-Engineered the UniFi API to Build WiFi Auth for 1,000 Daily Users"
date: "2026-05-01"
excerpt: "Yaponamama — Tashkent's largest restaurant chain — needed SMS-based WiFi auth across 14 locations. The UniFi docs didn't have what I needed. So I opened DevTools."
tags:
  - nodejs
  - backend
  - networking
  - javascript
---

# How I Reverse-Engineered the UniFi API to Build WiFi Auth for 1,000 Daily Users

Yaponamama. Tashkent's largest restaurant chain. 1,000 people connect to WiFi every single day. And when they needed a captive portal — SMS verification, session tracking, a management dashboard — the official UniFi documentation had exactly none of what I needed.

So I did what engineers do when the docs fail them: I opened the Network tab.

## The Problem

Yaponamama had three requirements.

First: **legal compliance**. Uzbekistan law requires public WiFi networks to authenticate users by phone number before granting internet access. Not optional, not a nice-to-have — a legal requirement. No auth, no WiFi.

Second: **scale**. Fourteen branch locations, 1,000+ daily sessions, peak loads at lunch and dinner. The auth system needed to be fast and resilient, not a single point of failure.

Third: **data**. They wanted to know who connected, from which access point, with which device. Guest analytics, essentially.

UniFi was already deployed across all branches — enterprise-grade hardware, solid wireless management, and (as I'd discover) a surprisingly capable internal API. The problem was that API was meant for Ubiquiti's own web UI, not third-party integrations. The documentation covered the basics — login, device discovery — but said nothing about guest authorization. Nothing about the captive portal flow. Nothing about the endpoint that would actually let my code say "this device is allowed on the internet now."

## The Approach

I started where documentation ends: watching what the UI does.

I logged into the UniFi controller's web interface, opened Chrome DevTools on the Network tab, filtered for XHR requests, and navigated to the Hotspot section where you manually authorize guest devices. One click. Thirteen requests. I filtered for anything that looked like it touched guest management.

There it was: a POST to `/api/s/default/cmd/stamgr`.

The payload was clean:

```json
{
  "cmd": "authorize-guest",
  "mac": "aa:bb:cc:dd:ee:ff",
  "minutes": 120
}
```

That was the guest authorization endpoint. Undocumented, but obvious once you see it. `stamgr` is station manager — it handles everything related to connected clients: authorize, unauthorize, kick, block.

The second thing I learned from the Network tab: UniFi uses cookie-based session auth. Not API tokens, not OAuth — a classic `unifises` cookie you get from POSTing credentials to `/api/login`. Every subsequent request carries that cookie. When the session expires (roughly an hour), you get a 401 back and need to re-login before retrying.

I also learned the hard way that UniFi controllers use self-signed SSL certificates. My first `axios` call threw a certificate error immediately. The fix is blunt but necessary for this environment:

```javascript
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});
```

Not something you'd do against a public API, but UniFi runs on your local network behind a firewall — this is the accepted pattern for self-hosted controller deployments.

## The Code

Once I understood the API shape, the implementation was straightforward. I built a `UnifiController` class that manages the session lifecycle:

```javascript
class UnifiController {
  constructor(config) {
    this.baseURL = `https://${config.host}:${config.port}`;
    this.site = 'default';
    this.cookies = null;
    this.lastLoginTime = null;
    this.sessionTimeout = 3_600_000; // 1 hour

    this.api = axios.create({
      baseURL: this.baseURL,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10_000,
    });

    axiosRetry(this.api, {
      retries: 2,
      retryDelay: (count) => count * 1000,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429 ||
        !err.response,
    });
  }

  isSessionValid() {
    if (!this.cookies || !this.lastLoginTime) return false;
    return Date.now() - this.lastLoginTime < this.sessionTimeout;
  }

  async login() {
    if (this.isSessionValid()) return this.cookies;

    const response = await this.api.post('/api/login', {
      username: this.username,
      password: this.password,
    });

    this.cookies = response.headers['set-cookie'];
    this.lastLoginTime = Date.now();
    return this.cookies;
  }

  async apiRequest(method, endpoint, data = null) {
    if (!this.isSessionValid()) await this.login();

    try {
      const response = await this.api({
        method,
        url: endpoint,
        headers: { Cookie: this.cookies.join(';') },
        ...(data && { data }),
      });
      return response.data;
    } catch (err) {
      // Session expired mid-flight — re-login and retry once
      if (err.response?.status === 401 || err.response?.status === 403) {
        this.cookies = null;
        await this.login();
        const response = await this.api({
          method,
          url: endpoint,
          headers: { Cookie: this.cookies.join(';') },
          ...(data && { data }),
        });
        return response.data;
      }
      throw err;
    }
  }
}
```

The session re-login on 401 matters in production. If the controller restarts, or the session times out between requests, the next call will fail. Without the retry, that failure propagates to the user — their OTP succeeded but they don't get WiFi. With it, they never notice.

The guest authorization call itself is almost anticlimactic after the investigation:

```javascript
async authorizeGuest(macAddress, minutes = 60) {
  return this.apiRequest('post', `/api/s/${this.site}/cmd/stamgr`, {
    cmd: 'authorize-guest',
    mac: macAddress.toLowerCase().trim(),
    minutes: parseInt(minutes, 10),
  });
}
```

One more piece worth showing: how the MAC address gets from the user's device to my API. When a device connects to the WiFi and hits the captive portal, UniFi redirects them to my portal URL with query parameters injected automatically:

```
https://portal.example.com/?ap=aa:bb:cc:dd:ee:ff&id=11:22:33:44:55:66&ssid=Yaponamama
```

`id` is the client's MAC address. `ap` is the access point they're connected to. `ssid` is the network name. The frontend reads these from `window.location.search` on load and stores them in state. When the user verifies their OTP, we send `macAddress` to the backend — which then calls `authorizeGuest(macAddress, sessionDuration)`.

For the OTP flow itself: a 6-digit code from `crypto.randomInt(100000, 999999)`, stored in Redis with a 60-second TTL, sent via SMS. On verification, we delete the key from Redis immediately — single use, no replay.

```javascript
async function verifyOTP(req, res) {
  const { phoneNumber, otp, macAddress } = req.body;

  const storedOTP = await redis.get(`otp:${phoneNumber}`);
  if (!storedOTP) return res.status(410).json({ message: 'OTP expired' });
  if (storedOTP !== otp) return res.status(401).json({ message: 'Incorrect OTP' });

  await redis.del(`otp:${phoneNumber}`);

  const authResult = await authorizeGuestWifi(macAddress);
  if (!authResult) return res.status(500).json({ message: 'WiFi auth failed' });

  const client = await getClient(macAddress);
  await saveGuestWifi(client, macAddress, phoneNumber, otp);

  res.json({ success: true });
}
```

## What I Learned

**The Network tab is better documentation than most docs.** The UniFi web UI makes every API call in plain sight. Intercepting browser traffic to understand an undocumented API is a legitimate engineering technique — especially for hardware vendor software that wasn't designed for external integration.

**Cookie sessions have their own expiry clock.** API tokens typically don't expire during a request. Cookies do. The 401-then-retry pattern isn't optional when your server process runs for days between restarts — you need to handle session expiry gracefully, not just at startup.

**Hardware vendor SSL is a category of its own.** Self-signed certificates are the norm for on-premise hardware. `rejectUnauthorized: false` is the expected solution in a controlled network environment. Worth knowing before your first certificate error at 2am.

**Redis TTL is the cleanest OTP store.** One key, one value, one expiry. No cron job to clean up expired codes. No separate `used` flag. The key disappears automatically — or you delete it on success. Either way, replay attacks are structurally impossible.

**UniFi's API is actually coherent once you find it.** The site-scoped pattern (`/api/s/{site}/...`) is consistent across every endpoint. Once you understand the shape, adding new operations is mechanical.


If you're building anything against a UniFi controller, it'll save you the week I spent staring at the Network tab.
