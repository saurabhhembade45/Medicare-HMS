import express from 'express';
import multer from 'multer';

import { 
    createDoctor, 
    deleteDoctor, 
    doctorLogin, 
    getDoctorById, 
    getDoctors, 
    toggleAvailability, 
    updateDoctor 
} from '../controllers/doctorController.js';

import doctorAuth from '../middlewares/doctorAuth.js';

const upload = multer({ dest: '/tmp' });

const doctorRouter = express.Router();

doctorRouter.get("/", getDoctors);
doctorRouter.post("/login", doctorLogin);
doctorRouter.get("/:id", getDoctorById);

doctorRouter.post(
  "/",
  (req, res, next) => {
    if (req.headers["content-type"]?.includes("multipart/form-data")) {
      upload.single("image")(req, res, next);
    } else {
      next();
    }
  },
  createDoctor
);

doctorRouter.put("/:id", doctorAuth, upload.single("image"), updateDoctor);
doctorRouter.post("/:id/toggle-availability", doctorAuth, toggleAvailability);
doctorRouter.delete("/:id", deleteDoctor);

export default doctorRouter;