# Local Event Crawler

A lightweight web app that crawls public pages to find online event listings near a location.

## How it works

1. Submit a location and optional keyword from the UI.
2. The server searches the web for relevant pages.
3. It crawls those pages and extracts `Event` entries from JSON-LD structured data.
4. Results are filtered to events whose venue/address match the location text.

## Run

```bash
npm start
```

Then open <http://localhost:3000>.

## API

### `POST /api/events/search`

Request body:

```json
{
  "location": "Austin, TX",
  "keyword": "music"
}
```

Response body:

```json
{
  "location": "Austin, TX",
  "keyword": "music",
  "scannedPages": 6,
  "foundEvents": 3,
  "events": []
}
```
