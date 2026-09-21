# Phase 0 legal gate — findings

`WEB.md` Phase 0 asks for a written go/no-go on publishing FashionWorks. This
file is the research behind that decision. **It is not the decision, and it is
not legal advice** — it is what CIG's published terms actually say, read
against what this tool actually does, so the call can be made on facts rather
than on vibes.

Sources, read 20 September 2026:

- **EULA** — <https://robertsspaceindustries.com/en/eula>
- **Star Citizen Fankit and Fandom FAQ** — RSI Knowledge Base, updated ~2 Sept 2026
- **Fan Film and Machinima Policy** — RSI Knowledge Base

## What the terms say

### The EULA restricts extraction to personal use

> "In whole or in part, copy, photocopy, reproduce, translate, reverse engineer,
> derive source code from, modify, disassemble, decompile, or create derivative
> works based on the Game Material; provided, however, that you may make copies
> of the Game Client and the Manuals **for personal purposes only**"

and separately prohibits

> "any unauthorized third party software that intercepts, 'mines', or otherwise
> collects information from or through the Game"

That second clause is written around runtime interception — it goes on to
mention reading the Game's RAM — so it is a poor fit for reading files already
on the visitor's disk. The first clause is the one that bites: extraction is
permitted, but as *personal* use.

### "Personal" is six people

The Fandom FAQ defines personal use as "yourself, your immediate family and/or
close friends only", and caps it at **six individuals including yourself**.
The local tool as it exists today sits inside that. A public web page does not.

### The licence that would cover a public tool is not available

Anything beyond six people is "Non-Commercial" in CIG's taxonomy, which
requires a **signed Non-Commercial License**. The FAQ states plainly:

> "We are not currently offering any Non-Commercial licenses."

So there is no route to making this formally authorised today. That is the
single most important finding here: the question is not "how do we get
permission", it is "do we publish without it".

### The blanket exemption does not cover tools

The FAQ exempts a specific list from needing a signed licence: images, videos
and live streams, plus fan sites, fan fiction and fan translation. Interactive
tools, asset extraction and 3D model handling are **not** on that list.

### 3D models are called out specifically

> "No permission is given to post, publish, upload, list, or offer our content
> to print-on-demand stores, 3d modelling, or other content websites for sale to
> or download by others."

This is the clause that lands hardest, because **the viewer exports GLB** — a
six-piece loadout comes out at 43.3 MB of CIG geometry, in a portable format,
as a file the visitor keeps. Client-side generation does not change what the
feature produces.

### Fan sites are allowed, with conditions

Permitted, provided the site carries this notice "open, obvious, and readily
seen", not hidden or shrunk:

> "This is an unofficial Star Citizen fan site, not affiliated with the Cloud
> Imperium group of companies. All content on this site not authored by its host
> or users are property of their respective owners."

Plus a link to the official site, no paywall or subscription, and a domain that
avoids "Star Citizen", "Roberts Space Industries", "Cloud Imperium",
"Turbulent", "Squadron 42" and in-game entity names. `sc-hangarworks.org`
appears to clear that list.

## How this maps onto the design

**In the tool's favour, and it is not nothing:**

- **The site serves zero game data.** The visitor reads their own installed
  files, in their own browser. Whatever else is true, CIG content is never
  copied, hosted or transmitted by us. `WEB.md`'s central design decision turns
  out to be the strongest legal argument available.
- Nothing is stored, nothing is uploaded, there is no account, no paywall and
  no advertising.
- The non-affiliation notice is already in the plan.

**Against:**

- A public tool exceeds the six-person personal-use cap, and the licence that
  would cover it is closed.
- It helps other people extract, so it arguably facilitates their EULA
  position, whatever ours is.
- **GLB export produces distributable CIG 3D assets**, against a clause that
  names 3D models specifically.

## What the options actually are

1. **Don't publish.** Keep it local and personal, inside the six-person cap.
   Zero risk, and the work is not wasted — the tool already exists.
2. **Publish without the export.** Dropping GLB export removes the clearest
   single conflict and leaves the browsing and kitbashing experience intact.
   Still unlicensed, still over the personal-use cap, but a viewer that renders
   from the visitor's own files is much closer to tolerated fan activity than
   an asset-extraction service.
3. **Publish as-is** and accept takedown risk.
4. **Ask anyway.** File a support ticket describing the tool. The FAQ says
   non-commercial licences are not on offer and asks people not to re-request,
   so expect no reply — but a documented good-faith attempt has some value.

**Worth weighing on the other side:** a large ecosystem of Star Citizen fan
tools operates openly, and cstone.space — the reference corpus this project now
uses — hosts extracted item images and statistics at scale. That is evidence of
practical tolerance, not of permission, and tolerance of *screenshots and stats*
is a weaker precedent than a tool that hands over meshes.

## Decision

**2026-09-21 — Noel: go.** The risk is accepted and publishing is no longer
gated on this file. What remains are the conditions below, which are cheap and
which keep the position defensible:

- the fan-site notice, verbatim and prominent, plus a link to the official site
- no ads, paywall, subscription or account
- **no game data served from the host**, which the architecture already
  guarantees and which is the strongest argument available
- ready to take it down on request

Advertising or a paid tier would move this into Commercial use, which the FAQ
prohibits outright; that would be a new decision, not a continuation of this
one, and would want real legal advice.

The recommendation below is kept as written, including the point about GLB
export, because it is the reasoning that was weighed rather than a pending
question.

## Recommendation

Option 2, if publishing at all: **ship without GLB export**, carry the fan-site
notice verbatim and prominently, link the official site, keep it free of ads,
paywalls and accounts, and be ready to take it down on request. That keeps the
strongest argument (we host nothing) and removes the weakest position (we hand
out 3D models).

This is a risk judgement about someone else's property and someone else's
hosting bill, so it is **Noel's call, not the agent's**. If the site ever
carries advertising or a paid tier, the analysis changes category entirely —
that becomes Commercial use, which the FAQ prohibits outright — and at that
point it is worth actual legal advice rather than a careful reading.

Until this is decided, the standing rule in `CLAUDE.md` holds: public
deployment of asset URLs is gated, and has not been done.
