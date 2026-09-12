# SIDE WALK production security setup

## Required environment variables

Set these on the backend host; never commit the real values:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `JWT_SECRET` (at least 32 random characters; 64+ recommended)
- `FRONTEND_ORIGINS` (comma-separated exact origins, no `*`)
- `COOKIE_SECURE=true` in production
- `COOKIE_SAMESITE=lax` when frontend and API are same-site; use `none` only when they are truly cross-site and HTTPS is used

Generate an admin password hash with:

```bash
npm run hash-password -- "your-long-password"
```

Generate a JWT secret with a cryptographically secure generator, for example:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Authentication model

Admin authentication uses a short-lived JWT in an `HttpOnly` cookie. JavaScript cannot read the session token. State-changing admin requests also require the CSRF token supplied by the readable CSRF cookie and `X-CSRF-Token` header.

The API does not accept anonymous access to administrative order/product/request operations.

## Secret rotation

Any secret that has ever been committed or shared should be considered compromised and replaced. Deleting a secret from the working tree does not remove it from Git history.

## Payment

The Aban Gateway integration is server-side. The API token and webhook secret must be supplied only through server environment variables. Payment completion is accepted only after a signed webhook/manual server verification, invoice/order/amount matching, and idempotent paid-state handling. Never expose payment secrets in frontend files or commit them to Git.
