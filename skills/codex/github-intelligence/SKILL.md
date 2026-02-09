---
name: github-intelligence
description: Query Proofwork GitHub intelligence (similar repos + reuse plans) from Codex.
---

# GitHub Intelligence (Codex)

This skill calls Proofwork intel endpoints:

- `POST /api/intel/similar`
- `POST /api/intel/reuse-plan`
- `GET /api/intel/provenance/:refId`

## Setup

Environment variables:

- `PROOFWORK_API_BASE_URL` (example: `https://api.proofwork.example`)
- `PROOFWORK_BUYER_TOKEN` (a `pw_bu_...` token from your Proofwork org)

## Commands

- Similar repos:
  - `node skills/codex/github-intelligence/scripts/similar.mjs "your idea"`
- Reuse plan:
  - `node skills/codex/github-intelligence/scripts/reuse-plan.mjs "your idea"`
- Policy / provenance:
  - `node skills/codex/github-intelligence/scripts/policy-explain.mjs <queryId|planId>`

