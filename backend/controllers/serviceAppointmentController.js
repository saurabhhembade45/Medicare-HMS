// controllers/serviceAppointmentController.js
import ServiceAppointment from "../models/serviceAppointment.js";
import Service from "../models/service.js"; 
import Razorpay from "razorpay";
import crypto from "crypto";
import { getAuth } from "@clerk/express";

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || null;
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || null;
const razorpay =
  razorpayKeyId && razorpayKeySecret
    ? new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret })
    : null;

const safeNumber = (val) => {
  if (val === undefined || val === null || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

function parseTimeString(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return null;
  const t = timeStr.trim();
  const m = t.match(/([0-9]{1,2}):?([0-9]{0,2})\s*(AM|PM|am|pm)?/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  let mm = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = (m[3] || "").toUpperCase();
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;

  if (ampm) {
    if (hh < 1 || hh > 12 || mm < 0 || mm > 59) return null;
    return { hour: hh, minute: mm, ampm };
  }

  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  if (hh === 0) return { hour: 12, minute: mm, ampm: "AM" };
  if (hh === 12) return { hour: 12, minute: mm, ampm: "PM" };
  if (hh > 12) return { hour: hh - 12, minute: mm, ampm: "PM" };
  return { hour: hh, minute: mm, ampm: "AM" };
}

const buildFrontendBase = (req) => {
  const env = process.env.FRONTEND_URL;
  if (env) return env.replace(/\/$/, "");
  const origin = req.get("origin") || req.get("referer") || null;
  return origin ? origin.replace(/\/$/, "") : null;
};

function resolveClerkUserId(req) {
  try {
    const auth = req.auth || {};
    const candidate = auth?.userId || auth?.user_id || auth?.user?.id || req.user?.id || null;
    if (candidate) return candidate;
    try {
      const serverAuth = getAuth ? getAuth(req) : null;
      return serverAuth?.userId || null;
    } catch (e) {
      return null;
    }
  } catch (e) {
    return null;
  }
}

/* CREATE */
export const createServiceAppointment = async (req, res) => {
  try {
    const body = req.body || {};
    const clerkUserId = resolveClerkUserId(req);
    if (!clerkUserId)
      return res
        .status(401)
        .json({ success: false, message: "Authentication required to create a service appointment." });

    const {
      serviceId,
      serviceName: serviceNameFromBody,
      patientName,
      mobile,
      age,
      gender,
      date,
      time,
      hour,
      minute,
      ampm,
      paymentMethod = "Online",
      amount: amountFromBody,
      fees: feesFromBody,
      email,
      meta = {},
      notes = "",
      serviceImageUrl: serviceImageUrlFromBody,
      serviceImagePublicId: serviceImagePublicIdFromBody,
    } = body;

    if (!serviceId) return res.status(400).json({ success: false, message: "serviceId is required" });
    if (!patientName || !String(patientName).trim())
      return res.status(400).json({ success: false, message: "patientName is required" });
    if (!mobile || !String(mobile).trim())
      return res.status(400).json({ success: false, message: "mobile is required" });
    if (!date || !String(date).trim())
      return res.status(400).json({ success: false, message: "date is required (YYYY-MM-DD)" });

    const numericAmount = safeNumber(amountFromBody ?? feesFromBody ?? 0);
    if (numericAmount === null || numericAmount < 0)
      return res.status(400).json({ success: false, message: "amount/fees must be a valid number" });

    let finalHour = hour !== undefined ? safeNumber(hour) : null;
    let finalMinute = minute !== undefined ? safeNumber(minute) : null;
    let finalAmpm = ampm || null;

    if (time && (finalHour === null || finalHour === undefined)) {
      const parsed = parseTimeString(time);
      if (!parsed)
        return res.status(400).json({ success: false, message: "time string couldn't be parsed" });
      finalHour = parsed.hour;
      finalMinute = parsed.minute;
      finalAmpm = parsed.ampm;
    }

    if (finalHour === null || finalMinute === null || (finalAmpm !== "AM" && finalAmpm !== "PM")) {
      return res
        .status(400)
        .json({ success: false, message: "Time missing or invalid — provide time string or hour, minute and ampm." });
    }

    // DUPLICATE BOOKING CHECK
    try {
      const existing = await ServiceAppointment.findOne({
        serviceId: String(serviceId),
        createdBy: clerkUserId,
        date: String(date),
        hour: Number(finalHour),
        minute: Number(finalMinute),
        ampm: finalAmpm,
        status: { $ne: "Canceled" },
      }).lean();
      if (existing)
        return res
          .status(409)
          .json({ success: false, message: "You already have a booking for this service at the selected date and time." });
    } catch (chkErr) {
      console.warn("Duplicate booking check failed:", chkErr);
    }

    // Fetch service snapshot (non-fatal)
    let svc = null;
    try {
      svc = await Service.findById(serviceId).lean();
    } catch (e) {
      console.warn("Service lookup failed:", e?.message || e);
    }

    let resolvedServiceName = serviceNameFromBody || (svc && (svc.name || svc.title)) || "Service";
    const svcImageUrlFromDB =
      svc && (String(svc.imageUrl || svc.image || svc.image?.url || svc.profileImage?.url || "").trim() || "");
    const svcImagePublicIdFromDB =
      svc &&
      (String(svc.imagePublicId || svc.image?.publicId || svc.profileImage?.publicId || "").trim() || "");
    const finalServiceImageUrl =
      svcImageUrlFromDB && svcImageUrlFromDB.length
        ? svcImageUrlFromDB
        : (serviceImageUrlFromBody && String(serviceImageUrlFromBody).trim()) || "";
    const finalServiceImagePublicId =
      svcImagePublicIdFromDB && svcImagePublicIdFromDB.length
        ? svcImagePublicIdFromDB
        : (serviceImagePublicIdFromBody && String(serviceImagePublicIdFromBody).trim()) || "";

    const base = {
      serviceId,
      serviceName: resolvedServiceName,
      serviceImage: { url: finalServiceImageUrl, publicId: finalServiceImagePublicId },
      patientName: String(patientName).trim(),
      mobile: String(mobile).trim(),
      age: age ? Number(age) : undefined,
      gender: gender || "",
      date: String(date),
      hour: Number(finalHour),
      minute: Number(finalMinute),
      ampm: finalAmpm,
      fees: numericAmount,
      createdBy: clerkUserId,
      notes: notes || "",
    };

    // Free appointment
    if (numericAmount === 0) {
      const created = await ServiceAppointment.create({
        ...base,
        status: "Pending",
        payment: { method: "Cash", status: "Pending", amount: 0, paidAt: new Date() },
      });
      return res.status(201).json({ success: true, appointment: created });
    }

    // Cash booking
    if (paymentMethod === "Cash") {
      const created = await ServiceAppointment.create({
        ...base,
        status: "Pending",
        payment: { method: "Cash", status: "Pending", amount: numericAmount, meta },
      });
      return res.status(201).json({ success: true, appointment: created, checkoutUrl: null });
    }

    // Online booking (Razorpay)
    if (!razorpay) return res.status(500).json({ success: false, message: "Razorpay not configured on server" });

    // Amount in paise (Razorpay expects smallest currency unit)
    const amountInPaise = Math.round(numericAmount * 100);

    let order;
    try {
      order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: `rcpt_${Date.now()}`,
        notes: {
          serviceId: String(serviceId),
          serviceName: String(resolvedServiceName).slice(0, 200),
          patientName: base.patientName,
          mobile: base.mobile,
          clerkUserId: base.createdBy || "",
          serviceImageUrl: finalServiceImageUrl ? String(finalServiceImageUrl).slice(0, 200) : "",
        },
      });
    } catch (razorpayErr) {
      console.error("Razorpay create order error:", razorpayErr);
      const message = razorpayErr?.error?.description || razorpayErr?.message || "Razorpay error";
      return res.status(502).json({ success: false, message: `Payment provider error: ${message}` });
    }

    try {
      const created = await ServiceAppointment.create({
        ...base,
        status: "Pending",
        payment: {
          method: "Online",
          status: "Pending",
          amount: numericAmount,
          sessionId: order.id || "", // store Razorpay order ID here
        },
      });
      return res.status(201).json({
        success: true,
        appointment: created,
        // Return order details so the frontend can open Razorpay checkout
        razorpayOrder: {
          orderId: order.id,
          amount: order.amount,
          currency: order.currency,
          keyId: razorpayKeyId,
        },
      });
    } catch (dbErr) {
      console.error("DB error saving service appointment after razorpay order:", dbErr);
      return res.status(500).json({ success: false, message: "Failed to create appointment record" });
    }
  } catch (err) {
    console.error("createServiceAppointment unexpected:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* CONFIRM — called after Razorpay payment success on the frontend */
export const confirmServicePayment = async (req, res) => {
  try {
    // Frontend must POST: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "razorpay_order_id, razorpay_payment_id and razorpay_signature are all required",
      });
    }

    if (!razorpayKeySecret) {
      return res.status(500).json({ success: false, message: "Razorpay not configured" });
    }

    // Verify signature
    const expectedSignature = crypto
      .createHmac("sha256", razorpayKeySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Invalid payment signature" });
    }

    // Update the appointment that holds this order ID (stored in payment.sessionId)
    const appt = await ServiceAppointment.findOneAndUpdate(
      { "payment.sessionId": razorpay_order_id },
      {
        $set: {
          "payment.status": "Confirmed",
          "payment.providerId": razorpay_payment_id,
          "payment.paidAt": new Date(),
          status: "Confirmed",
        },
      },
      { new: true }
    );

    if (!appt)
      return res.status(404).json({ success: false, message: "Service appointment not found" });

    return res.json({ success: true, appointment: appt });
  } catch (err) {
    console.error("confirmServicePayment:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* GET list */
export const getServiceAppointments = async (req, res) => {
  try {
    const { serviceId, mobile, status, page: pageRaw = 1, limit: limitRaw = 50, search = "" } = req.query;
    const limit = Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 50));
    const page = Math.max(1, parseInt(pageRaw, 10) || 1);
    const skip = (page - 1) * limit;

    const filter = {};
    if (serviceId) filter.serviceId = serviceId;
    if (mobile) filter.mobile = mobile;
    if (status) filter.status = status;
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [{ patientName: re }, { mobile: re }, { notes: re }];
    }

    const appointments = await ServiceAppointment.find(filter)
      .populate("serviceId", "name image imageUrl imageSmall")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await ServiceAppointment.countDocuments(filter);

    return res.json({ success: true, appointments, meta: { page, limit, total, count: appointments.length } });
  } catch (err) {
    console.error("getServiceAppointments:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* GET by id */
export const getServiceAppointmentById = async (req, res) => {
  try {
    const { id } = req.params;
    const appt = await ServiceAppointment.findById(id).lean();
    if (!appt) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, data: appt });
  } catch (err) {
    console.error("getServiceAppointmentById:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* UPDATE */
export const updateServiceAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const updates = {};

    if (body.status !== undefined) updates.status = body.status;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.payment !== undefined) updates.payment = body.payment;
    if (body["payment.status"] !== undefined) updates["payment.status"] = body["payment.status"];

    if (body.rescheduledTo) {
      const { date, time } = body.rescheduledTo || {};
      updates.rescheduledTo = {};
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
          return res
            .status(400)
            .json({ success: false, message: "rescheduledTo.date must be YYYY-MM-DD" });
        updates.rescheduledTo.date = date;
        updates.date = date;
      }
      if (time) {
        updates.rescheduledTo.time = String(time);
        const parsed = parseTimeString(String(time));
        if (!parsed)
          return res
            .status(400)
            .json({ success: false, message: "rescheduledTo.time couldn't be parsed" });
        updates.hour = parsed.hour;
        updates.minute = parsed.minute;
        updates.ampm = parsed.ampm;
        updates.time = `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")} ${parsed.ampm}`;
      }
      if (!body.status) updates.status = "Rescheduled";
    }

    if (updates.payment) {
      const method = updates.payment.method || updates.payment?.method;
      if (method && String(method).toLowerCase() === "online")
        updates.status = updates.status || "Confirmed";
      if (updates.payment.status && updates.payment.status === "Confirmed") {
        updates.status = "Confirmed";
        if (updates.payment.paidAt === undefined) updates.payment.paidAt = new Date();
      }
    }

    const updated = await ServiceAppointment.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error("updateServiceAppointment:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* CANCEL */
export const cancelServiceAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const appt = await ServiceAppointment.findById(id);
    if (!appt) return res.status(404).json({ success: false, message: "Not found" });
    if (appt.status === "Completed")
      return res.status(400).json({ success: false, message: "Cannot cancel a completed appointment" });

    appt.status = "Canceled";
    if (appt.payment)
      appt.payment.status = appt.payment.status === "Confirmed" ? "Canceled" : "Pending";
    await appt.save();
    return res.json({ success: true, data: appt });
  } catch (err) {
    console.error("cancelServiceAppointment:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* STATS */
export const getServiceAppointmentStats = async (req, res) => {
  try {
    const services = await Service.aggregate([
      {
        $lookup: {
          from: "serviceappointments",
          localField: "_id",
          foreignField: "serviceId",
          as: "appointments",
        },
      },
      {
        $addFields: {
          totalAppointments: { $size: "$appointments" },
          completed: {
            $size: {
              $filter: { input: "$appointments", as: "a", cond: { $eq: ["$$a.status", "Completed"] } },
            },
          },
          canceled: {
            $size: {
              $filter: { input: "$appointments", as: "a", cond: { $eq: ["$$a.status", "Canceled"] } },
            },
          },
        },
      },
      { $addFields: { earning: { $multiply: ["$completed", "$price"] } } },
      {
        $project: {
          name: 1,
          price: 1,
          image: "$imageUrl",
          totalAppointments: 1,
          completed: 1,
          canceled: 1,
          earning: 1,
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    return res.json({ success: true, services, totalServices: services.length });
  } catch (err) {
    console.error("getServiceAppointmentStats:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* GET appointments for current patient (/me) */
export const getServiceAppointmentsByPatient = async (req, res) => {
  try {
    const clerkUserId = resolveClerkUserId(req);
    const { createdBy, mobile } = req.query;
    const resolvedCreatedBy = createdBy || clerkUserId || null;
    if (!resolvedCreatedBy && !mobile) return res.json({ success: true, data: [] });

    const filter = {};
    if (resolvedCreatedBy) filter.createdBy = resolvedCreatedBy;
    if (mobile) filter.mobile = mobile;

    const list = await ServiceAppointment.find(filter).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error("getServiceAppointmentsByPatient:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export default {
  createServiceAppointment,
  confirmServicePayment,
  getServiceAppointments,
  getServiceAppointmentById,
  updateServiceAppointment,
  cancelServiceAppointment,
  getServiceAppointmentStats,
  getServiceAppointmentsByPatient,
};