import { Router, type IRouter } from "express";
import healthRouter      from "./health";
import usbPhonesRouter   from "./usb-phones";
import farmDevicesRouter from "./farm-devices";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usbPhonesRouter);
router.use(farmDevicesRouter);

export default router;
