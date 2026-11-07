# Access and audit: who is here, who did what, and why

Everyone signs in with their own key; every call is recorded with its reason.

## You

`whoami`: your email, the company, your permissions (read, write, approve) and this session
(when it started, when it ends, which key). Permissions decide what you may do: write for
changes, approve for approving orders, payout accounts and the rules page.

## Who has access (approve)

- `users_list`: each member's email, name, permissions and status, their keys (label, created,
  last used, revoked; never the key itself) and who is signed in now (each live session's
  client, start, last use and end).
- `auth_events_list`: the sign-in history (sign-ins, tokens issued and refreshed, sessions
  ended, keys revoked) with who, client, key label and address.

Keys are issued and revoked by an administrator, not through these tools. Revoking a key ends
its sessions at once; sessions also end 30 days after sign-in.

## Who did what

- `audit_list`: recent tool calls with who made them, their reasons and the operations each
  ran (filter by `since` or `tool`). Use it to answer "who changed this and why".
- `change_history`: what actually changed in the records, newest first: each insert, update
  or delete with the values before and after (only the changed fields for an update), and the
  operation, person and reason behind it. Filter by `table` (supplier, contact, item,
  purchase_order...), `row_id` or `since`. Use it to answer "what was this before".
- `wiki_history` gives the same for wiki pages; records such as stock movements, quotes and
  orders keep their own history and authors.
- `operation_status` checks one write by its `request_key`, for example after a timeout.

## The rules

`company_rules_get` returns the rules page and its last change (when, by whom, why).
