/**
 * Phone Farm Device Registry
 *
 * Persists the slot → serial mapping so the UI always knows which physical
 * phone belongs in which grid cell, even if USB cables are swapped. The slot
 * is bound to the ADB serial number (hardware-burned into the device), not
 * the USB port, so the mapping survives cable swaps and server restarts.
 *
 * Endpoints:
 *   GET    /api/mobile/farm-devices              — list all registered devices
 *   POST   /api/mobile/farm-devices              — register a phone to next slot
 *   DELETE /api/mobile/farm-devices/:slotIndex   — remove a device from a slot
 */

import { Router } from "express";
import { sqlite } from "@workspace/db";

const router = Router();

interface FarmDevice {
  slotIndex:      number;
  serial:         string;
  displayName:    string;
  model:          string;
  manufacturer:   string;
  androidVersion: string;
  addedAt:        string;
}

function rowToDevice(row: any): FarmDevice {
  return {
    slotIndex:      row.slot_index,
    serial:         row.serial,
    displayName:    row.display_name ?? "",
    model:          row.model ?? "",
    manufacturer:   row.manufacturer ?? "",
    androidVersion: row.android_version ?? "",
    addedAt:        row.added_at,
  };
}

/**
 * GET /api/mobile/farm-devices
 * Returns all registered farm devices ordered by slot.
 */
router.get("/mobile/farm-devices", (_req, res) => {
  const rows = sqlite
    .prepare("SELECT * FROM phone_farm_devices ORDER BY slot_index ASC")
    .all();
  if (rows.length === 0) {
    console.warn("[device-watchdog] farm-devices database query returned zero registered devices");
  }
  res.json({ devices: rows.map(rowToDevice) });
});

/**
 * POST /api/mobile/farm-devices
 * Body: { serial, displayName?, model?, manufacturer?, androidVersion? }
 *
 * Assigns the phone to the lowest available positive slot.
 * If the serial is already registered, returns its existing slot.
 */
router.post("/mobile/farm-devices", (req, res) => {
  const { serial, displayName, model, manufacturer, androidVersion } = req.body ?? {};
  if (!serial || typeof serial !== "string") {
    res.status(400).json({ ok: false, error: "serial is required" });
    return;
  }

  // If serial already registered, return as-is
  const existing = sqlite
    .prepare("SELECT * FROM phone_farm_devices WHERE serial = ?")
    .get(serial) as any;
  if (existing) {
    res.json({ ok: true, device: rowToDevice(existing), alreadyRegistered: true });
    return;
  }

  // Find the first available slot without imposing a farm-size ceiling.
  const usedSlots = new Set((
    sqlite
      .prepare("SELECT slot_index FROM phone_farm_devices ORDER BY slot_index ASC")
      .all() as { slot_index: number }[]
  ).map(r => r.slot_index));

  let nextSlot = 1;
  while (usedSlots.has(nextSlot)) {
    nextSlot += 1;
    if (!Number.isSafeInteger(nextSlot)) {
      res.status(500).json({ ok: false, error: "No available device slot index" });
      return;
    }
  }

  const addedAt = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO phone_farm_devices
       (slot_index, serial, display_name, model, manufacturer, android_version, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nextSlot,
    serial.trim(),
    (displayName ?? "").trim(),
    (model ?? "").trim(),
    (manufacturer ?? "").trim(),
    (androidVersion ?? "").trim(),
    addedAt,
  );

  const created = sqlite
    .prepare("SELECT * FROM phone_farm_devices WHERE slot_index = ?")
    .get(nextSlot) as any;
  res.json({ ok: true, device: rowToDevice(created) });
});

/**
 * DELETE /api/mobile/farm-devices/:slotIndex
 * Removes the device in the given slot.
 */
router.delete("/mobile/farm-devices/:slotIndex", (req, res) => {
  const slotIndex = parseInt(req.params.slotIndex, 10);
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 1) {
    res.status(400).json({ ok: false, error: "Invalid slotIndex" });
    return;
  }
  const result = sqlite
    .prepare("DELETE FROM phone_farm_devices WHERE slot_index = ?")
    .run(slotIndex);
  res.json({ ok: true, deleted: result.changes > 0 });
});

export default router;
