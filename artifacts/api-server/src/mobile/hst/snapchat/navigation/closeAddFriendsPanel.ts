import * as android from "../../../androidManager";
import type { SnapchatContext } from "../context";
import { dump } from "../runtime";

export async function closeAddFriendsPanel(context: SnapchatContext): Promise<boolean> {
  const current = await dump(context.serial);
  if (/camera_page/i.test(current.xml) && !/add_friends_root/i.test(current.xml)) return true;
  if (!/add_friends_root/i.test(current.xml)) {
    context.onLog("Snapchat: cannot close Add Friends because its panel is not confirmed.");
    return false;
  }
  try {
    await android.keyevent(context.serial, 4);
  } catch {
    context.onLog("Snapchat: Android Back failed while closing the Add Friends panel.");
    return false;
  }
  await context.sleep(200, "exact");
  const after = await dump(context.serial);
  if (/camera_page/i.test(after.xml) && !/add_friends_root/i.test(after.xml)) {
    context.onLog("Snapchat: returned to Camera with Android Back.");
    return true;
  }
  context.onLog("Snapchat stopped: Android Back did not close the Add Friends panel.");
  return false;
}
