# 0219. Pairing codes minted in the chat

- Status: Accepted
- Date: 2026-11-24
- Extends: ADR 0036 §5 (the device-code flow), ADR 0056 §10 (pre-confirmed codes)
- Code: engine `machine-device.ts` (`issuePairingCode`, `redeemPairingCode`), server `routes/machines.ts` (`POST …/machines/device-codes`, `POST /machines/device/redeem`), runner `pairing.ts` (`redeemPairingCode`, `pairWithCode`) and `main.ts` (`pair --code`); db migration 0324

## Context

Connecting a computer today starts at the computer: it asks for a code, shows it with a link, and a person confirms it on the site. That works when someone sits at the computer and can open the site — but not when the computer is somewhere else and the person who may connect it is in a chat: an external AI, a provisioner, or someone on the phone. The managed-computer flow (ADR 0056 §10) already issues a pre-confirmed code server-side, but only for the workspace's own computer, and only the operator's provisioner may ask for one. What is missing is a chat-side issuer: a member mints a short code for an organization, reads it to whoever sits at the computer, and the computer redeems it — with the agent it should run for already named, so a new machine gets its agents without someone pointing them at it afterwards.

## Decision

1. **Mint in the chat.** `POST /api/app/organizations/{orgId}/machines/device-codes` (session + CSRF, members who may pair computers) mints a 6-character code for the organization, optionally bound to one agent (`agentId`). The answer carries the short code, its expiry and the agent — never a polling secret. The mint is the trust boundary: at most 10 codes per member per organization per hour, the target agent only when the minter manages it (`managesAgent`), never the right hand, never where agents live on the workspace computer (`mayBeHome`). The audit entry (`machine.pairing_code_issued`) names the agent, never the code.
2. **The code is born confirmed.** The row in `machineDeviceCodes` (`issued_via = 'chat'`, migration 0324 adds `issued_via` and `target_agent_id`) is `confirmed` for its org from the mint, with the minter as `confirmed_by`, and lives 10 minutes. It never answers the confirm page (`pending` only), and the mint stores a hash of random bytes nobody was told: the polling secret does not exist yet.
3. **Redeem with just the short code.** `POST /api/machines/device/redeem` (no session) takes the short code and the computer's fingerprint (name, OS, arch, hostname, version). It makes the machine (`connected`, paired by the minter), claims the code by setting `machine_id` where it was null — so a second redeem finds nothing — rotates the polling secret (fresh random bytes, only the hash kept), and returns the secret once, to the computer that held the short code. Guessing is bounded as on the confirm page: ~887M codes, 30 redeems per address per 10 minutes, 10 minutes to live. The computer then polls `…/device/token` with the secret, exactly like a web-confirmed code, and the token is issued once.
4. **Post-connect assignment.** When the code named an agent, redeem puts it on the new machine in the same transaction — but only when it has no computer yet (`machine_id` null, not archived). When it already has one, is archived, is the right hand, or is gone, the machine still connects and the redeem answer says so (`assignedAgent` null, `assignmentSkipped` naming why). When no agent was named, nothing is assigned: the computer stays unassigned and the answer says so, never silently taking a random agent.
5. **The runner.** `agentes-runner pair --server <url> --code <code>` redeems, polls, and prints which agent runs on the computer, or why none does. `--code` takes nothing else (`--enroll-file`, `--link` are refused with it), and a minted code is always a fresh computer: no reconnect.

## Consequences

- Whoever holds a minted code for 10 minutes can connect a computer to that organization: the code is the credential, so it is read only to the person at that computer, like a password. The mint cap and the redeem budget bound how many live codes one member can float and how fast one address can guess.
- A redeemed code behaves like a web-confirmed one from then on: the machine is dropped if its token is never collected before expiry, the admins are notified, and the token is issued once. A code that expires unredeemed leaves nothing behind.
- The short code alone never yields a machine token: it yields the polling secret, and only the first poll after that yields the token. The secret is never stored in plaintext, never returned to the web client, and never written to the audit log.
- What this slice does not do: no button in the chat or on the Devices page mints a code (the endpoint is there; the UI is a later slice), and no code is ever listed or revoked from the app — an unwanted live code dies in at most 10 minutes, or when redeemed.
