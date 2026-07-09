import { Router, type IRouter } from "express";
import healthRouter    from "./health";
import usbPhonesRouter from "./usb-phones";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usbPhonesRouter);

export default router;
