# rapido-sim

A Rapido-style tester for the W2N Action Screen API. A rider books a ride, and an action screen goes to a list of
drivers, either all at once (first Accept wins, then it's withdrawn for the others) or one by one (a Skip or timeout
withdraws it and offers the next driver). Node 20+, no dependencies.

## Run
```bash
W2N_API_KEY=... W2N_API_SECRET=... npm start      # http://localhost:3000
npm test                                           # smoke test against a fake W2N
```

| Env | Default |
|---|---|
| `W2N_API_KEY`, `W2N_API_SECRET` | required |
| `APP_ID` | `6a3ba941db31e8b79fc3aa12` |
| `W2N_API_BASE` | `https://api.webtonativebeta.orufy.in/api/v1/push-notification` |
| `PORT` | `3000` (Railway sets it) |

## Deploy on Railway
New project → Deploy from repo (or `railway up` in this folder) → set the env variables above. The start command is `npm start`.

## Dashboard setup (one time per screen)
In the screen's chains, add a **Call your API** step:
- **On Accept:** `POST https://<your-app>.up.railway.app/api/rides/{{ride_id}}/accept`
- **On Reject:** `POST https://<your-app>.up.railway.app/api/rides/{{ride_id}}/reject` (needed for one-by-one dispatch to move on when a driver skips)

The server adds `ride_id` to every request's `data` (and `driver_id` when the ride is offered to one driver).
A late Accept gets `409`.

## Who accepted
- **One by one:** the driver the ride was offered to.
- **All at once:** the `driver_id` cookie from the website (the apps send the cookies of `testUrl`, else `websiteLink`),
  else an `x-driver-id` header, else `driver_id` in the body. Otherwise `unknown`.

## API
| Route | Use |
|---|---|
| `POST /api/rides` | `{screen_id, expires_in, platforms, drivers: [externalUserId...], mode: "broadcast"\|"sequential", data}`. An empty `drivers` list sends to EVERYONE. |
| `GET /api/rides`, `GET /api/rides/:id` | Status, offers (one per W2N request), events. |
| `POST /api/rides/:id/accept` / `reject` | Called by the app's chains. |
| `POST /api/rides/:id/cancel` / `withdraw` | Rider cancels (withdraws the open request) / manual withdraw. |
| `GET /api/logs` | The last 200 chain calls, with headers, cookies and body: check `variables` and cookies here. |

The test page is at `/`. Host it elsewhere with `?api=https://<your-app>.up.railway.app`.

State is in memory: a restart or redeploy clears it.

## Sample action screen
`action-screen/ride_request.html` is a Rapido-style ride request screen: pickup/drop, fare, countdown ring, and
Skip / Accept buttons (`onReject()` / `onAccept()`). Upload it as the screen's HTML in the dashboard and use the
page's default `data`, which matches it. Open it in a browser to preview it with sample values.
