# Cheapest Practical `5k` Mixed-Traffic Infrastructure Plan

## Summary

For this repo and the current production shape, a truly free setup is not realistic for a real `5k` mixed-traffic target.

The cheapest practical path is:

- keep Cloudflare at the edge
- keep the current recorded-video provider and storage path for now
- split the current single production box into a small Hetzner multi-node cluster
- certify `5k` as **mixed traffic first**, not `5k` simultaneous video viewers

Recommended working budget:

- **best cheap serious target:** about `€210–€230/month` before VAT
- **ultra-cheap transition:** about `€55–€90/month` extra on top of the current single-host spend, but that is not a real `5k` claim

## Best Cheap Architecture

Use Hetzner EU pricing with Cloudflare in front.

- `4 x CCX23` for app/API replicas
- `2 x CPX32` for recorded-video manifest/gateway/cache
- `1 x AX41-NVMe` for Postgres
- `1 x CPX32` for Redis and lightweight workers
- `1 x LB11` Hetzner load balancer
- keep object/video storage on the current provider path unless later cost or performance data proves a change is worth it

### Approximate monthly estimate

- `4 x CCX23` = `4 x €31.49` = `€125.96/mo`
- `2 x CPX32` = `2 x €13.99` = `€27.98/mo`
- `1 x AX41-NVMe` = about `€42.30/mo` in Germany or about `€36.70/mo` in Finland
- `1 x CPX32` = `€13.99/mo`
- `1 x LB11` = `€7.49/mo`

Total:

- **Germany DB host:** about `€217.72/mo`
- **Finland DB host:** about `€212.12/mo`

Then add:

- backups / extra IPs
- VAT if applicable
- current video-storage bill

## Cheapest Transition Path

### Phase 1: cheapest meaningful improvement

Add only:

- `1 x AX41-NVMe` or `EX44` for Postgres
- `1 x CPX32` for Redis and workers

Expected cost:

- about `€50–€60/mo` extra

Why:

- removes the biggest DB and cache contention from the current single host
- is the cheapest meaningful upgrade
- is still **not enough** for an honest `5k` mixed-traffic claim

### Phase 2: first real `5k` mixed candidate

Move to:

- `4` app nodes
- `2` recorded-video media nodes
- dedicated Postgres
- dedicated Redis
- load balancer

This is the first low-cost shape that should be treated as a serious `5k` mixed candidate for this repo.

## What Not To Do

Do not use “free server” ideas for this target.

Free is acceptable only for helper layers like:

- Cloudflare DNS / proxy free tier
- tiny Cloudflare R2 free-tier usage

That is fine around the edges, but not for real `5k` mixed production.

Also do not keep:

- app
- Postgres
- Redis
- manifest/cache
- workers

on one production box and expect a real `5k` mixed claim. The repo evidence already says that shape is not trustworthy.

## Video Storage and Streaming Choice

For the cheapest practical near-term plan:

- do **not** migrate video storage just to save a little money
- spend the first extra budget on splitting compute roles
- keep Cloudflare in front

Use this decision rule:

- if the current recorded-video provider and storage path is functioning, keep it during the infra split
- only rework storage after the `50`, `100`, `250`, and mixed-load gates show where the real bottleneck is

Longer term, if cost or control forces a consolidation, standardize recorded lessons on one hot path only. But that is a later phase, not the first cheap `5k` move.

## Relation to Existing Repo Gates

This infrastructure plan does not replace the current certification flow. Keep using:

- `./scripts/run-recorded-browser-ladder.sh`
- `./scripts/run-course-video-ladder.sh`
- `./scripts/run-platform-scale-ladder.sh`
- `./scripts/run-5k-mixed-readiness.sh`

The infra spend is only justified after these gates prove the current bottlenecks clearly.

## Practical Recommendation

If budget is tight:

1. do the Phase 1 DB/Redis split first
2. finish recorded-video stabilization
3. pass browser `50`, then `100`, then `250`
4. pass mixed app `2000`, then `5000`
5. only then scale into the full Phase 2 cluster

If you can afford the cleaner move immediately, skip Phase 1 and go straight to the `€210–€230/mo` serious candidate.

## Pricing References

- Hetzner cloud, dedicated server, load balancer, and storage pricing adjustment notice: `docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/`
- Hetzner cloud server docs and pricing guidance: `docs.hetzner.com/cloud/servers/overview`
- Hetzner AX dedicated server line docs: `docs.hetzner.com/robot/dedicated-server/server-lines/ax-server/`
- Cloudflare R2 pricing docs: `developers.cloudflare.com/r2/pricing/`
