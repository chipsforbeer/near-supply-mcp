# NEAR Payment MCP

An optional payment companion for [Supplier Inventory MCP](../README.md).
It helps an AI assistant review and pay purchase orders that a human has already
approved, then track their outcome.

## Capabilities

- Preview an approved payment before money moves.
- Check readiness, available funds, and spending limits.
- Pay an eligible order within its approval and configured limits.
- Review payment status and recover interrupted work.
- Assist with wallet setup and funding.
- Support public test payments and confidential payment options on NEAR.

## Typical workflow

1. An authorized person approves the order and supplier payment details.
2. Review the payment preview and any reasons it cannot proceed.
3. Request payment when authorized and ready.
4. Review the outcome alongside the purchase order.

The payment component cannot approve its own orders. Human approval and payment
execution remain separate responsibilities.

## Operating limits

- Mainnet payments use real funds. Public payment activity is visible; confidential
  options still involve providers that can see relevant transaction information.
- Payment eligibility depends on the approved amount, supported currency,
  available balance, and configured spending limits. Keep only the funds needed
  for intended payments available to the payer.
- Use one active payment instance per payer. Sharing a payer across independent
  instances is unsupported. Review uncertain outcomes before retrying, and retain
  pending payment records.
- Protect credentials and confirm supplier payment details through a trusted
  channel. Never paste private keys or sign-in credentials into an AI chat.

Examples and demonstration data are fictional. Payment services, accounts, and
credentials must be supplied separately.
