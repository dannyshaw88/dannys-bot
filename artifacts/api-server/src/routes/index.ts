import { Router, type IRouter } from "express";
import healthRouter      from "./health";
import usbPhonesRouter   from "./usb-phones";
import farmDevicesRouter from "./farm-devices";
import addFriendsScrollReplayRouter from "./add-friends-scroll-replay";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usbPhonesRouter);
router.use(farmDevicesRouter);
router.use(addFriendsScrollReplayRouter);

export default router;
