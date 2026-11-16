# Premise

**Assumption tripwires for decisions in Confluence and Jira.**

Decisions don't become wrong. They expire.

A team writes "we'll run orders on a single Postgres instance, because traffic is under 1,000 requests per second." That is correct the day it is written. Eighteen months later traffic is 4,000 a second, nobody reread the page, and the decision is quietly wrong. The page still looks authoritative. Nothing ever told anyone it had gone stale.

Premise reads the decision, pulls out the assumptions holding it up, and watches each one. When an assumption stops being true, it says so on the page and opens a Jira ticket to revisit the decision.

An Atlassian Forge app, built for Codegeist 2026.

---

## How it works

1. **Extract.** Open a decision page in Confluence and press *Extract assumptions*. Forge's LLM reads the page and pulls out the conditions the decision depends on, with a suggested Jira search for each one.
2. **Confirm.** You review what it found. Each assumption gets a tripwire: a Jira search and a limit (*trips when more than 3 issues match*), or a date. Press **Test** to see what the search matches right now, before you commit to a limit.
3. **Watch.** Premise checks every tripwire hourly. The page byline shows the live state without anyone opening anything.
4. **Act.** When a wire trips, the assumption shows **Broken**, Premise opens a *Revisit decision* ticket assigned to whoever saved the decision, and any decision that builds on this one is flagged as at risk.

The signal is a proxy, not a measurement. A Jira search is a rough stand-in for "is this still true", so Premise shows its working: the exact issues that tripped the wire, and a **Not relevant** button on each one when the search caught something it shouldn't have.

## What it uses

| Piece | What it does |
| --- | --- |
| **Confluence byline + panel** | Live status on the decision page itself |
| **Forge LLM** (`claude-haiku-4-5`) | Reads prose, returns assumptions and candidate searches |
| **Jira search + issue creation** | The tripwire signal, and the revisit ticket |
| **Teamwork Graph** | Publishes decisions as graph objects; finds owners, contributors and the decisions that depend on this one |
| **Rovo agent** (4 actions) | "Which decisions are at risk?" in natural language |
| **MCP server** | The same four tools, for any MCP client |
| **Scheduled trigger + queue** | Hourly checks, batched so a large site stays within limits |
| **Forge KVS** | Decision records, plus a summary index so the dashboard reads one key instead of walking every record |

Everything runs on Atlassian infrastructure. No external services, no egress.

## The cascade

Decisions rest on other decisions. When *"single Postgres instance for orders"* breaks, *"orders reporting uses Postgres read replicas"* is built on sand, and Premise says so on both pages. That link comes from Teamwork Graph, not from anything anyone had to wire up by hand.

## Honest limits

- **The tripwire is a proxy.** Counting Jira issues matching `text ~ "orders"` is not the same as measuring requests per second. It fires on ticket hygiene noise, and it misses assumptions nobody files tickets about. The Test button and the Not relevant control exist because of this, not in spite of it. Better sources (Compass metrics, JSM incidents) are the obvious next step.
- **It needs decisions to be written down.** Premise can only watch what somebody wrote.
- **Extraction is a first draft.** The AI proposes, a human confirms. Nothing is watched until someone presses Save.

## Backtest

Run against 37 real decision pages, the AI's extraction was scored by a second model at 29 correct. On manual review that number was wrong, so it was audited down and the honest figure is **15 of 37**. Premise reports 15.

## Install

Listed on the Atlassian Marketplace, or installed via a private link for evaluation.

Requires Confluence and Jira on the same Atlassian cloud site.

## Development

```bash
npm install
forge deploy -e development
forge install -e development
```

Scale and backtest harnesses are gated to the development environment and will refuse to run in production.

## Licence

MIT. See [LICENSE](LICENSE). Privacy policy: [PRIVACY.md](PRIVACY.md).
