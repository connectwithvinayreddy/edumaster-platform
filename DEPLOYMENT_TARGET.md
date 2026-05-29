# Production Deployment Target

Use this target when the user asks to deploy the live VaronEnglish app.

- App domain: `https://app.varonenglishapp.in`
- Live domain: `https://live.varonenglishapp.in`
- Origin server IP from Cloudflare DNS: `178.105.48.179`
- SSH target: `root@178.105.48.179`
- Remote app directory: `/opt/edumaster`
- Deploy command:

```bash
./infra/lowcost/deploy-hetzner.sh root@178.105.48.179 /opt/edumaster
```

Notes:
- `app.varonenglishapp.in` and `live.varonenglishapp.in` are Cloudflare-proxied DNS records, so SSH must use the origin IP.
- Current recorded video production path is Cloudflare-backed private video delivery; Cloudflare DNS/CDN alone is not Cloudflare Stream.

Cloudflare Stream values already provided:

- Account ID: `f0b016edfe6c436ad21db65095f32169`
- Customer subdomain: `customer-n4gq9hqs6xwi4c4p.cloudflarestream.com`
- Customer code for env: `n4gq9hqs6xwi4c4p`

Still needed to enable Stream upload mode:

- `CLOUDFLARE_STREAM_API_TOKEN`
- `CLOUDFLARE_STREAM_WEBHOOK_SECRET` after webhook creation
