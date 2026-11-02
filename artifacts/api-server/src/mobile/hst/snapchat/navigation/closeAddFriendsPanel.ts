import * as android from "../../../androidManager";
import type { SnapchatContext } from "../context";

export async function closeAddFriendsPanel(context: SnapchatContext): Promise<boolean> {
  try {
    await android.keyevent(context.serial, 4);
  } catch {
    context.onLog("Snapchat: Android Back failed while closing the Add Friends panel.");
    return false;
  }
  await context.sleep(200, "exact");
  context.onLog("Snapchat: sent Android Back to leave the completed friend list.");
  return true;
}
