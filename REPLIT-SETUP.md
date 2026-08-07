# Replit Setup — Run This After Importing From GitHub

## Step 1 — Open the Shell tab and run:
```
pnpm install
```
Wait for it to finish (takes ~1 minute).

## Step 2 — Start the app:
Click the **Run** button at the top of Replit.

That's it. Both servers will start:
- API Server on port 3000
- Frontend on port 5000 (visible in the preview pane)

---

## If the preview shows a blank screen:
The workflows may need a manual restart. In the Shell run:
```
pnpm --filter @workspace/api-server run dev
```
and in a second Shell tab:
```
PORT=5000 API_PORT=3000 pnpm --filter @workspace/dannys-bot run dev
```
