# Data-in-Transit Encryption Policy

**Document Title:** Data-in-Transit Encryption Policy
**Application:** Configure.News (https://configure.news)
**Effective Date:** February 9, 2026
**Version:** 1.0
**Classification:** Internal / Compliance

---

## 1. Purpose

This policy defines the requirements and technical controls for protecting all data transmitted to, from, and within the Configure.News platform. It ensures that all Platform Data — including data received from or related to Facebook and Meta platforms — is protected using industry-standard encryption during transit.

---

## 2. Scope

This policy applies to all data in transit across the following systems and communication paths:

- The Configure.News web application (https://configure.news)
- The backend API server hosted on Render.com
- The PostgreSQL database hosted on Supabase (https://supabase.com)
- All third-party API integrations (OAuth providers, payment processors, social media APIs)
- Communication between end-user browsers and application servers
- Communication between application servers and database services
- Webhook callbacks from external services

---

## 3. Policy Statements

> ### **>>> STATEMENT 1: ENCRYPTION OF ALL DATA IN TRANSIT <<<**
>
> **All Platform Data is encrypted in transit. Platform Data is never transmitted without encryption in transit.**
>
> Every network communication path within the Configure.News platform enforces TLS (Transport Layer Security) encryption. No data — including Facebook Platform Data — is ever transmitted over an unencrypted channel. All HTTP requests are automatically upgraded to HTTPS. Unencrypted HTTP connections are not accepted in the production environment.

---

> ### **>>> STATEMENT 2: PROHIBITION OF SSL VERSION 2 AND SSL VERSION 3 <<<**
>
> **SSL version 2 (SSLv2) and SSL version 3 (SSLv3) are explicitly disabled and are never used. Only TLS 1.2 and TLS 1.3 protocols are permitted for all data in transit.**
>
> The Configure.News platform exclusively uses TLS 1.2 and TLS 1.3 for all encrypted communications. The deprecated and insecure SSL 2.0 and SSL 3.0 protocols are disabled at the infrastructure level and cannot be negotiated by any client or server within our system. This applies to all endpoints, services, and integrations.

---

## 4. Technical Implementation

The following technical controls enforce this policy across all layers of the application:

### 4.1 TLS Termination (Infrastructure Layer)

Configure.News is deployed on **Render.com**, which provides automatic TLS termination at the edge for all deployed services:

- **TLS Certificates:** Automatically provisioned and renewed via Let's Encrypt.
- **Supported Protocols:** TLS 1.2 and TLS 1.3 only. SSL 2.0, SSL 3.0, and TLS 1.0/1.1 are disabled at the infrastructure level by Render.
- **Cipher Suites:** Render enforces modern, secure cipher suites and disables weak ciphers.
- **Certificate Type:** Domain-validated (DV) certificates with automatic renewal.

### 4.2 HTTP Strict Transport Security (HSTS)

The application enforces HSTS to prevent protocol downgrade attacks and cookie hijacking:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

- **max-age:** 31,536,000 seconds (1 year) — browsers will refuse non-HTTPS connections for this duration.
- **includeSubDomains:** HSTS applies to all subdomains.
- **preload:** The domain is eligible for inclusion in the HSTS preload list maintained by major browsers.

*Implementation:* Helmet.js middleware in `server.js`, lines 132–136.

### 4.3 Content Security Policy — Upgrade Insecure Requests

In the production environment, the Content Security Policy includes the `upgrade-insecure-requests` directive, which instructs browsers to automatically upgrade any insecure (HTTP) resource requests to HTTPS:

```
Content-Security-Policy: upgrade-insecure-requests
```

*Implementation:* Helmet.js CSP configuration in `server.js`, line 128.

### 4.4 Secure Cookie Transmission

All cookies are configured with the `Secure` flag in the production environment, ensuring they are only transmitted over HTTPS connections:

| Cookie | httpOnly | Secure (Production) | SameSite |
|--------|----------|---------------------|----------|
| authToken (JWT) | Yes | Yes | Strict |
| Session cookie | Yes | Yes | Strict |
| CSRF token | No (required for JS access) | Yes | Strict |

*Implementation:*
- Auth token cookie: `routes/auth.js`, lines 39–45
- Session cookie: `server.js`, lines 538–543
- CSRF cookie: `middleware/csrf.js`, lines 13–19

### 4.5 Database Connections

All connections to the Supabase PostgreSQL database are encrypted using TLS 1.2+:

- **Supabase URL:** All API calls made over HTTPS (`https://[project].supabase.co`).
- **Supabase Infrastructure:** Supabase enforces TLS 1.2 as the minimum protocol version for all database connections and API endpoints. SSL 2.0 and SSL 3.0 are not supported.
- **Connection Mode:** Both the public client (respecting Row Level Security) and the admin client (server-side only) connect exclusively over TLS-encrypted channels.

*Implementation:* `services/supabase.js`

### 4.6 Third-Party API Integrations

All external API communications are conducted exclusively over HTTPS/TLS:

| Service | Endpoint | Protocol |
|---------|----------|----------|
| Google OAuth | https://accounts.google.com | TLS 1.2+ |
| Lemon Squeezy (Payments) | https://api.lemonsqueezy.com | TLS 1.2+ |
| OpenAI API | https://api.openai.com | TLS 1.2+ |
| Twitter/X API | https://api.twitter.com | TLS 1.2+ |
| LinkedIn API | https://api.linkedin.com | TLS 1.2+ |
| Facebook Graph API | https://graph.facebook.com | TLS 1.2+ |
| Reddit API | https://oauth.reddit.com | TLS 1.2+ |
| Telegram Bot API | https://api.telegram.org | TLS 1.2+ |
| GNews API | https://gnews.io | TLS 1.2+ |
| Google Analytics | https://www.google-analytics.com | TLS 1.2+ |

No plaintext HTTP endpoints are used for any integration.

### 4.7 Webhook Security

Incoming webhooks (e.g., from Lemon Squeezy for payment events) are verified using HMAC-SHA256 signature validation with timing-safe comparison, ensuring data integrity and authenticity of the encrypted payload:

*Implementation:* `server.js`, lines 209–241.

---

## 5. Enforcement and Monitoring

### 5.1 Preventive Controls

- **Infrastructure-Level Enforcement:** Render.com disables SSL 2.0, SSL 3.0, TLS 1.0, and TLS 1.1 at the load balancer/edge level. These protocols cannot be negotiated regardless of application configuration.
- **HSTS Preload:** Prevents browsers from ever attempting an unencrypted connection.
- **Secure Cookie Flags:** Prevent cookie transmission over unencrypted channels.
- **CSP Upgrade Directive:** Automatically upgrades any residual insecure requests.

### 5.2 Detective Controls

- **SSL/TLS Testing:** Periodic Qualys SSL Labs scans are performed against https://configure.news to verify TLS configuration and identify any weaknesses.
- **Audit Logging:** All incoming requests are logged with protocol and authentication metadata for security monitoring.
- **Security Event Logging:** Failed authentication attempts, CSRF violations, and webhook signature failures are logged with security-level severity.

### 5.3 Environment Configuration Validation

The application validates critical security configuration at startup:
- JWT secret presence and strength is verified.
- Session secret is required in the production environment.
- Database connection parameters are validated before service initialization.

---

## 6. Compliance Verification

To verify compliance with this policy, the following evidence can be produced:

1. **Qualys SSL Labs Report** — Full scan of https://configure.news demonstrating TLS 1.2/1.3 support and absence of SSL 2.0/3.0.
2. **Application Source Code** — Security headers, cookie configurations, and HSTS settings as referenced in this document.
3. **Render.com Platform Documentation** — Confirming automatic TLS 1.2+ enforcement and SSL 2/3 deprecation.
4. **Supabase Security Documentation** — Confirming TLS 1.2+ enforcement on all database connections.

---

## 7. Document Control

| Field | Value |
|-------|-------|
| **Document Owner** | Configure.News Engineering |
| **Approved By** | [Name / Title] |
| **Effective Date** | February 9, 2026 |
| **Review Cycle** | Annually, or upon significant infrastructure changes |
| **Version** | 1.0 |
| **Next Review Date** | February 9, 2027 |

---

*This document was prepared in compliance with Meta/Facebook Platform Terms and Data Security Requirements.*
