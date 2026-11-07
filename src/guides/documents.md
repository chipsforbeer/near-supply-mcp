# Documents: where files are, what they say, finding them

Every quote, certificate, spec sheet and safety sheet stays where it is. The server stores no files: a document is its details, the text that matters, and where the file is.

## Keeping a file

- **A file on this computer** (saved from email with the mail tool, or already on disk): read
  it with your own tools, then `document_add` with `location` (the full path, for example
  `C:\Users\buyer\Documents\quotes\q-5531.pdf`), `kind`, `title` and the `text` you read
  from it that matters: prices, quantities, values, dates, heat and certificate numbers. Pass
  the file's `sha256` (and `size_bytes`) when you can compute them: the same file, or the
  same location, saved again returns the existing document.
- **A file at a link** (a supplier's datasheet or certificate on their website, a shared
  drive): `document_add` with the link as `location`, and the text if you read it.
- **Text with no file** (an email body, call notes): `document_capture_text` with `title`,
  `kind`, `text`, `source` (`mail` or `note`).

`kind` is one of spec_sheet, drawing, sds, coa, mill_cert, coc, quote, invoice, certificate,
email, photo, note, other. Set `valid_until` on certificates and safety sheets.

## Using documents

- `document_get` returns the details, the `location`, who saved it (`saved_by`) and the saved
  text (page through long ones with `offset` and `max_chars`). To look at the file itself,
  open it at its `location`. A path works only on the machine of the person who saved it:
  if it is not on this computer, say whose it is rather than guessing what it says.
- `document_update` changes the `location` when a file moved, the `title` or `kind`, the
  saved `text` (it replaces it) or `valid_until`. Fields left out keep their value.
- `document_link` ties a document to an item, spec, supplier, contact, RFQ, quote, lot,
  purchase order, production run, wiki page, interaction or evaluation.
- `document_search` searches the titles and saved text; `documents_expiring` lists
  certificates and sheets that expire within `within_days`.

Pass document ids wherever a record cites a source: `source_document_id` on quotes,
`evidence_document_ids` on evaluations, `cert_document_id` on receipts, `document_ids` on
interactions and specs.
