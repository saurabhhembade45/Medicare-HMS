// controllers/appointmentController.js

import Razorpay from "razorpay";
import crypto from "crypto";
import Appointment from "../models/Appointment.js";
import Doctor from "../models/Doctor.js";
import dotenv from "dotenv";
import { getAuth } from "@clerk/express";
import { clerkClient } from "@clerk/clerk-sdk-node";

dotenv.config();

/* ---------------- Razorpay Setup ---------------- */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const MAJOR_ADMIN_ID = process.env.MAJOR_ADMIN_ID || null;

/* ---------------- Helpers ---------------- */

const safeNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function resolveClerkUserId(req) {
  try {
    const auth = req.auth || {};
    return (
      auth?.userId ||
      auth?.user_id ||
      auth?.user?.id ||
      req.user?.id ||
      (getAuth ? getAuth(req)?.userId : null) ||
      null
    );
  } catch {
    return null;
  }
}

/* ---------------- GET ALL ---------------- */

export const getAppointments = async (req, res) => {
  try {
    const {
      doctorId,
      mobile,
      status,
      search = "",
      limit = 50,
      page = 1,
    } = req.query;

    const skip = (page - 1) * limit;

    const filter = {};
    if (doctorId) filter.doctorId = doctorId;
    if (mobile) filter.mobile = mobile;
    if (status) filter.status = status;

    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [{ patientName: re }, { mobile: re }, { notes: re }];
    }

    const items = await Appointment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("doctorId", "name specialization owner imageUrl image")
      .lean();

    const total = await Appointment.countDocuments(filter);

    return res.json({
      success: true,
      appointments: items,
      meta: { page, limit, total },
    });
  } catch {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- GET BY PATIENT ---------------- */

export const getAppointmentsByPatient = async (req, res) => {
  try {
    const clerkUserId = req.auth?.userId || null;

    if (!clerkUserId && !req.query.mobile) {
      return res.status(401).json({ success: false });
    }

    const filter = {};
    if (clerkUserId) filter.createdBy = clerkUserId;
    if (req.query.mobile) filter.mobile = req.query.mobile;

    const appointments = await Appointment.find(filter)
      .sort({ date: 1, time: 1 })
      .lean();

    return res.json({ success: true, appointments });
  } catch {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- GET BY DOCTOR ---------------- */

export const getAppointmentsByDoctor = async (req, res) => {
  try {
    const { doctorId } = req.params;

    if (!doctorId) {
      return res.status(400).json({ success: false });
    }

    const {
      mobile,
      status,
      search = "",
      limit = 50,
      page = 1,
    } = req.query;

    const skip = (page - 1) * limit;

    const filter = { doctorId };

    if (mobile) filter.mobile = mobile;
    if (status) filter.status = status;

    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [{ patientName: re }, { mobile: re }, { notes: re }];
    }

    const items = await Appointment.find(filter)
      .sort({ date: 1, time: 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("doctorId", "name specialization owner imageUrl image")
      .lean();

    const total = await Appointment.countDocuments(filter);

    return res.json({
      success: true,
      appointments: items,
      meta: { page, limit, total },
    });
  } catch {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- GET BY ID ---------------- */

export const getAppointmentById = async (req, res) => {
  try {
    const appt = await Appointment.findById(req.params.id)
      .populate("doctorId")
      .lean();

    if (!appt) return res.status(404).json({ success: false });

    return res.json({ success: true, appointment: appt });
  } catch {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- CREATE ---------------- */

export const createAppointment = async (req, res) => {
  try {
    const {
      doctorId,
      patientName,
      mobile,
      date,
      time,
      fee,
      paymentMethod,
    } = req.body;

    const clerkUserId = resolveClerkUserId(req);
    if (!clerkUserId) return res.status(401).json({ success: false });

    if (!doctorId || !patientName || !mobile || !date || !time) {
      return res.status(400).json({ success: false });
    }

    const numericFee = safeNumber(fee ?? 0);
    if (numericFee === null || numericFee < 0) {
      return res.status(400).json({ success: false });
    }

    // Duplicate booking check
    const existingBooking = await Appointment.findOne({
      doctorId,
      createdBy: clerkUserId,
      date: String(date),
      time: String(time),
      status: { $ne: "Canceled" },
    });

    if (existingBooking) {
      return res.status(409).json({ success: false, message: "Slot already booked" });
    }

    const doctor = await Doctor.findById(doctorId).lean();
    if (!doctor) return res.status(404).json({ success: false });

    const base = {
      doctorId,
      doctorName: doctor.name,
      speciality: doctor.specialization,
      patientName,
      mobile,
      date,
      time,
      fees: numericFee,
      status: "Pending",
      payment: {
        method: paymentMethod === "Cash" ? "Cash" : "Online",
        status: "Pending",
        amount: numericFee,
      },
      createdBy: clerkUserId,
      owner: doctor.owner || MAJOR_ADMIN_ID,
      sessionId: null,
    };

    /* FREE */
    if (numericFee === 0) {
      const created = await Appointment.create({
        ...base,
        status: "Confirmed",
        payment: { method: "Free", status: "Paid", amount: 0 },
        paidAt: new Date(),
      });
      return res.json({ success: true, appointment: created });
    }

    /* CASH */
    if (paymentMethod === "Cash") {
      const created = await Appointment.create(base);
      return res.json({ success: true, appointment: created });
    }

    /* RAZORPAY */
    const order = await razorpay.orders.create({
      amount: Math.round(numericFee * 100),
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    });

    const created = await Appointment.create({
      ...base,
      sessionId: order.id,
    });

    return res.json({
      success: true,
      appointment: created,
      orderId: order.id,
      amount: order.amount,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- VERIFY PAYMENT ---------------- */

export const confirmPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false });
    }

    const appt = await Appointment.findOneAndUpdate(
      { sessionId: razorpay_order_id },
      {
        status: "Confirmed",
        "payment.status": "Paid",
        "payment.providerId": razorpay_payment_id,
        paidAt: new Date(),
      },
      { new: true }
    );

    if (!appt) return res.status(404).json({ success: false });

    return res.json({ success: true, appointment: appt });
  } catch {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- UPDATE ---------------- */

export const updateAppointment = async (req, res) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false });

    Object.assign(appt, req.body);
    await appt.save();

    return res.json({ success: true, appointment: appt });
  } catch {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- CANCEL ---------------- */

export const cancelAppointment = async (req, res) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false });

    appt.status = "Canceled";
    await appt.save();

    return res.json({ success: true, appointment: appt });
  } catch {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- STATS ---------------- */

export const getStats = async (req, res) => {
  try {
    const total = await Appointment.countDocuments();

    const revenueAgg = await Appointment.aggregate([
      { $match: { "payment.status": "Paid" } },
      { $group: { _id: null, total: { $sum: "$fees" } } },
    ]);

    const revenue = revenueAgg[0]?.total || 0;

    return res.json({ success: true, stats: { total, revenue } });
  } catch {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- REGISTERED USERS ---------------- */

export const getRegisteredUserCount = async (req, res) => {
  try {
    const totalUsers = await clerkClient.users.getCount();

    return res.json({
      success: true,
      totalUsers,
    });
  } catch (err) {
    return res.status(500).json({ success: false });
  }
};

/* ---------------- EXPORT ---------------- */

export default {
  getAppointments,
  getAppointmentById,
  getAppointmentsByPatient,
  createAppointment,
  confirmPayment,
  updateAppointment,
  cancelAppointment,
  getStats,
  getAppointmentsByDoctor,
  getRegisteredUserCount,
};