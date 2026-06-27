# ADTMC+ Clinical AI Worker

Dedicated Cloudflare Worker for the ADTMC+ Ask Dr. Holtkamp clinical navigator.

## Behavior

- Uses `gemini-3.1-flash-lite` with `gemini-3.5-flash` as fallback.
- Accepts requests only from the deployed GitHub Pages origin and listed local development origins.
- Keeps the system instruction and model selection server-side.
- Validates structured responses and read-only navigation targets.
- Stores no chat or clinical data and logs metadata only.

## Local checks

```sh
npm ci
npm run cf-typegen
npm run check
npm run deploy -- --dry-run
```

For local Worker development, create an ignored `.dev.vars` file containing:

```text
GEMINI_API_KEY=your-local-development-key
```

Never commit `.dev.vars` or an API key.

## GitHub deployment

The deployment workflow requires these repository Actions secrets:

- `GEMINI_API_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Pushes to `main` deploy automatically when this Worker or its workflow changes. The workflow can also be run manually.
