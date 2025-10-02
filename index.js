import express from "express";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// -------------------- Firebase Service Account from Environment Variables --------------------
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

// -------------------- Firebase Init --------------------
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://automated-toll-system-c2f6c-default-rtdb.firebaseio.com/"
  });
  console.log("✅ Firebase Admin initialized successfully");
} catch (error) {
  console.error("❌ Firebase Admin initialization failed:", error);
}

const db = admin.database();

// -------------------- Environment Variables --------------------
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const IFTTT_KEY = process.env.IFTTT_KEY;

// -------------------- RFID → Paystack Customer Mapping --------------------
const rfidToCustomer = JSON.parse(process.env.RFID_MAPPING || '{"7a5a3d02":"CUS_nqf4gq1bbkwf2kx","937db7e4":"CUS_v4k17y3gstgxpbt","14973ca3":"CUS_wzphr3hmdh2is1q"}');

// -------------------- Vehicle Email Mapping --------------------
const rfidToEmail = {
  "7a5a3d02": process.env.VEHICLE_7A5A3D02_EMAIL || "baffoestephen980@gmail.com",
  "937db7e4": process.env.VEHICLE_937DB7E4_EMAIL || "billionsblay233257@gmail.com",
  "14973ca3": process.env.VEHICLE_14973CA3_EMAIL || "mentorgabriel000@gmail.com"
};

console.log("🔑 Loaded RFID Mapping:", Object.keys(rfidToCustomer));
console.log("📧 Loaded Email Mapping:", rfidToEmail);

// -------------------- IFTTT Webhook Helper --------------------
function sendIFTTTWebhook(eventName, value1, value2, value3, value4) {
  if (!IFTTT_KEY) {
    console.log("IFTTT key not configured");
    return;
  }
  const url = `http://maker.ifttt.com/trigger/${eventName}/with/key/${IFTTT_KEY}?value1=${value1}&value2=${value2}&value3=${value3}&value4=${value4}`;
  console.log(`🔔 Sending IFTTT: ${eventName}`, { value1, value2, value3, value4 });
  axios.get(url).catch(err => console.error("IFTTT error:", err.message));
}

// -------------------- IMPROVED Paystack Top-up Link Generator --------------------
async function createPaymentLink(rfid, customerId, amount) {
  try {
    console.log(`🔗 Creating payment link for RFID: ${rfid}, Customer: ${customerId}, Amount: ₵${amount / 100}`);
    
    if (!PAYSTACK_SECRET_KEY) {
      console.error("❌ Paystack secret key not configured");
      return { status: "error", error: "Paystack secret key not configured" };
    }

    const response = await axios.post(
      "https://api.paystack.co/paymentrequest",
      {
        customer: customerId,
        amount: amount,
        currency: "GHS",
        description: `Toll system top-up for RFID ${rfid}`,
        metadata: {
          rfid: rfid,
          purpose: "toll_topup",
          timestamp: new Date().toISOString()
        },
        channels: ["card", "mobile_money"],
        line_items: [
          {
            name: `Toll Top-up for ${rfid}`,
            amount: amount,
            quantity: 1
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    console.log("📡 Paystack API Response Status:", response.data.status);
    console.log("📊 Paystack API Full Response:", JSON.stringify(response.data, null, 2));

    if (response.data && response.data.status) {
      const paymentData = response.data.data;
      console.log("✅ Payment request created successfully");
      
      // IMPROVED: Extract payment link from different possible fields
      let paymentLink = "";
      
      if (paymentData.link) {
        paymentLink = paymentData.link;
        console.log("🔗 Using 'link' field:", paymentLink);
      } else if (paymentData.hosted_link) {
        paymentLink = paymentData.hosted_link;
        console.log("🔗 Using 'hosted_link' field:", paymentLink);
      } else if (paymentData.checkout_url) {
        paymentLink = paymentData.checkout_url;
        console.log("🔗 Using 'checkout_url' field:", paymentLink);
      } else if (paymentData.authorization_url) {
        paymentLink = paymentData.authorization_url;
        console.log("🔗 Using 'authorization_url' field:", paymentLink);
      } else {
        console.log("❌ No payment link found in Paystack response");
        console.log("💡 Available fields:", Object.keys(paymentData));
      }
      
      console.log("📋 Reference:", paymentData.reference);
      
      if (!paymentLink) {
        console.error("❌ No payment link generated by Paystack");
        return { 
          status: "failed", 
          error: "No payment link generated by Paystack",
          details: "Available fields: " + Object.keys(paymentData).join(", ")
        };
      }
      
      return {
        status: "success",
        amount: amount,
        link: paymentLink,
        reference: paymentData.reference,
        message: "Payment link generated successfully"
      };
    } else {
      console.error("❌ Paystack API error:", response.data);
      return { 
        status: "failed", 
        error: response.data.message || "Paystack API error",
        details: response.data
      };
    }
  } catch (err) {
    console.error("❌ Paystack request error:");
    console.error("Error Message:", err.message);
    if (err.response) {
      console.error("Response Data:", err.response.data);
      console.error("Response Status:", err.response.status);
    }
    return { 
      status: "error", 
      error: err.response ? err.response.data : err.message 
    };
  }
}

// -------------------- ESP32 Endpoint: Request Top-up --------------------
app.post("/esp32/topup", async (req, res) => {
  console.log("\n" + "=".repeat(50));
  console.log("💳 TOP-UP REQUEST FROM ESP32");
  console.log("=".repeat(50));
  
  const { rfid, amount } = req.body;

  console.log(`📌 RFID: ${rfid}`);
  console.log(`💵 Amount: ₵${amount / 100}`);
  console.log(`🔢 Amount in pesewas: ${amount}`);

  if (!rfid || !amount) {
    console.error("❌ Missing RFID or amount in request");
    return res.status(400).json({ 
      status: "failed", 
      error: "Missing RFID or amount" 
    });
  }

  const normalizedRfid = rfid.toLowerCase();
  console.log(`🔍 Looking up RFID: ${normalizedRfid}`);
  
  if (!rfidToCustomer[normalizedRfid]) {
    console.error("❌ Unknown RFID:", normalizedRfid);
    console.log("📋 Available RFIDs:", Object.keys(rfidToCustomer));
    return res.status(400).json({ 
      status: "failed", 
      error: `Unknown RFID: ${rfid}. Please register this tag.` 
    });
  }

  const customerId = rfidToCustomer[normalizedRfid];
  console.log(`👤 Customer ID: ${customerId}`);
  
  console.log("🔄 Calling Paystack API...");
  const result = await createPaymentLink(normalizedRfid, customerId, amount);

  console.log("📊 Paystack Result:", JSON.stringify(result, null, 2));

  if (result.status === "success") {
    console.log("✅ Payment link created successfully");
    console.log("🔗 Final Payment Link:", result.link);
    
    // Update vehicle email in Firebase if missing
    const vehicleEmail = rfidToEmail[normalizedRfid];
    if (vehicleEmail) {
      try {
        const vehicleRef = db.ref(`vehicles/${normalizedRfid}`);
        const snapshot = await vehicleRef.once("value");
        if (snapshot.exists() && !snapshot.val().email) {
          await vehicleRef.update({ email: vehicleEmail });
          console.log("✅ Email updated in Firebase:", vehicleEmail);
        }
      } catch (error) {
        console.error("❌ Failed to update email in Firebase:", error);
      }
    }
    
    // Send IFTTT notification
    sendIFTTTWebhook(
      "topup_requested",
      normalizedRfid,
      `₵${amount / 100}`,
      result.link,
      "Payment link generated successfully"
    );
    
    // Return proper JSON response
    res.json({
      status: "success",
      amount: amount,
      link: result.link,
      reference: result.reference,
      message: "Payment link generated successfully"
    });
  } else {
    console.error("❌ Failed to create payment link:", result.error);
    
    sendIFTTTWebhook(
      "topup_error",
      normalizedRfid,
      `₵${amount / 100}`,
      result.error?.message || "Unknown Paystack error",
      "Failed to generate payment link"
    );
    
    res.status(500).json({
      status: "failed",
      error: result.error?.message || "Failed to create payment link",
      details: result.error
    });
  }
  
  console.log("=".repeat(50));
});

// -------------------- Webhook for Paystack (Payment Processing) --------------------
app.post("/paystack/webhook", async (req, res) => {
  console.log("\n" + "=".repeat(50));
  console.log("📡 INCOMING PAYSTACK WEBHOOK");
  console.log("=".repeat(50));
  
  try {
    const event = req.body;
    console.log("📥 Event Type:", event.event);
    console.log("📋 Webhook Data:", JSON.stringify(event.data, null, 2));

    if (event.event === "charge.success") {
      const metadata = event.data.metadata;
      const rfid = metadata?.rfid;
      const amountPaid = event.data.amount / 100;
      const timestamp = new Date().toISOString();
      const reference = event.data.reference;
      const customerEmail = event.data.customer?.email;

      console.log("💰 PAYMENT SUCCESSFUL!");
      console.log(`🔑 RFID: ${rfid}`);
      console.log(`💵 Amount Paid: GH₵${amountPaid}`);
      console.log(`📧 Customer Email: ${customerEmail}`);
      console.log(`🔢 Reference: ${reference}`);
      console.log(`⏰ Time: ${timestamp}`);

      if (!rfid) {
        console.error("❌ No RFID found in Paystack metadata");
        console.log("📋 Available metadata:", metadata);
        return res.status(400).send("No RFID in metadata");
      }

      const normalizedRfid = rfid.toLowerCase();
      const vehicleRef = db.ref(`vehicles/${normalizedRfid}`);
      const snapshot = await vehicleRef.once("value");

      if (!snapshot.exists()) {
        console.error("❌ No vehicle found with RFID:", normalizedRfid);
        sendIFTTTWebhook(
          "unknown_topup",
          normalizedRfid,
          `GH₵${amountPaid}`,
          reference,
          "No vehicle linked to this RFID"
        );
        return res.status(404).json({ error: "Vehicle not found" });
      }

      const vehicleData = snapshot.val();
      const currentBalance = vehicleData.balance || 0;
      const currentDebt = vehicleData.debt || 0;
      const vehicleEmail = vehicleData.email || rfidToEmail[normalizedRfid];

      console.log(`🚗 Vehicle Found: ${normalizedRfid}`);
      console.log(`📧 Vehicle Email: ${vehicleEmail}`);
      console.log(`💳 Current Balance: GH₵${currentBalance}`);
      console.log(`📉 Current Debt: GH₵${currentDebt}`);

      // Update vehicle email if missing
      if (!vehicleData.email && vehicleEmail) {
        await vehicleRef.update({ email: vehicleEmail });
        console.log("✅ Email updated for vehicle:", vehicleEmail);
      }

      let remainingAmount = amountPaid;
      let newDebt = currentDebt;
      let newBalance = currentBalance;

      // Clear debt first
      if (currentDebt > 0) {
        if (remainingAmount >= currentDebt) {
          remainingAmount -= currentDebt;
          newDebt = 0;
          console.log(`✅ Debt cleared: GH₵${currentDebt}`);
        } else {
          newDebt = currentDebt - remainingAmount;
          remainingAmount = 0;
          console.log(`✅ Partial debt cleared: GH₵${remainingAmount}`);
        }
      }

      // Add remaining to balance
      if (remainingAmount > 0) {
        newBalance = currentBalance + remainingAmount;
        console.log(`💰 Added to balance: GH₵${remainingAmount}`);
      }

      console.log(`💳 New Balance: GH₵${newBalance}`);
      console.log(`📉 New Debt: GH₵${newDebt}`);

      try {
        // Update Firebase with both balance and debt
        const updates = {
          balance: newBalance,
          debt: newDebt,
          lastTopup: timestamp,
          lastTopupAmount: amountPaid
        };

        // Ensure email is set
        if (!vehicleData.email && vehicleEmail) {
          updates.email = vehicleEmail;
        }

        await vehicleRef.update(updates);

        console.log("✅ Firebase updated successfully");

        // Log the transaction
        const transactionId = Date.now();
        const historyRef = db.ref(`transactions/${normalizedRfid}/${transactionId}`);
        await historyRef.set({
          type: "topup",
          amount: amountPaid,
          balance_before: currentBalance,
          balance_after: newBalance,
          debt_before: currentDebt,
          debt_after: newDebt,
          debt_cleared: currentDebt - newDebt,
          time: timestamp,
          source: "Paystack Top-up",
          reference: reference,
          status: "completed",
          customer_email: customerEmail
        });

        console.log("✅ Transaction logged successfully");

        // Send appropriate notification
        if (currentDebt > 0) {
          sendIFTTTWebhook(
            "debt_cleared",
            normalizedRfid,
            `GH₵${currentDebt - newDebt}`,
            `GH₵${newBalance}`,
            `Remaining debt: GH₵${newDebt} | Ref: ${reference}`
          );
        } else {
          sendIFTTTWebhook(
            "topup_completed",
            normalizedRfid,
            `GH₵${amountPaid}`,
            `GH₵${newBalance}`,
            `Reference: ${reference}`
          );
        }

        console.log("✅ Webhook processed successfully");

      } catch (firebaseError) {
        console.error("❌ Firebase update error:", firebaseError);
        sendIFTTTWebhook(
          "firebase_error",
          normalizedRfid,
          `GH₵${amountPaid}`,
          firebaseError.message,
          "Failed to update Firebase after payment"
        );
      }
    } else if (event.event === "charge.failed") {
      console.log("❌ Payment failed:", event.data);
      const rfid = event.data.metadata?.rfid;
      if (rfid) {
        sendIFTTTWebhook(
          "payment_failed",
          rfid,
          `GH₵${event.data.amount / 100}`,
          event.data.gateway_response || "Payment failed",
          event.data.reference
        );
      }
    } else {
      console.log("ℹ Other Paystack event:", event.event);
    }

    res.sendStatus(200);
    console.log("✅ Webhook response sent");
    
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    res.sendStatus(500);
  }
  
  console.log("=".repeat(50));
});

// -------------------- Manual Balance Update Endpoint --------------------
app.post("/manual/update-balance", async (req, res) => {
  console.log("\n" + "=".repeat(50));
  console.log("🔧 MANUAL BALANCE UPDATE");
  console.log("=".repeat(50));
  
  const { rfid, balance, debt } = req.body;

  console.log(`📌 RFID: ${rfid}`);
  console.log(`💵 Balance: GH₵${balance}`);
  console.log(`📉 Debt: GH₵${debt}`);

  if (!rfid) {
    return res.status(400).json({ error: "RFID is required" });
  }

  try {
    const normalizedRfid = rfid.toLowerCase();
    const vehicleRef = db.ref(`vehicles/${normalizedRfid}`);
    const updates = {};
    
    if (balance !== undefined) updates.balance = parseFloat(balance) || 0;
    if (debt !== undefined) updates.debt = parseFloat(debt) || 0;
    updates.last_manual_update = new Date().toISOString();

    await vehicleRef.update(updates);

    console.log("✅ Manual update successful");
    
    // Log the manual update
    const transactionId = Date.now();
    const historyRef = db.ref(`transactions/${normalizedRfid}/${transactionId}`);
    await historyRef.set({
      type: "manual_update",
      balance: parseFloat(balance) || 0,
      debt: parseFloat(debt) || 0,
      time: new Date().toISOString(),
      source: "manual"
    });

    res.json({ 
      status: "success", 
      message: "Balance updated successfully",
      rfid: normalizedRfid,
      balance: parseFloat(balance) || 0,
      debt: parseFloat(debt) || 0
    });
  } catch (error) {
    console.error("❌ Manual update failed:", error);
    res.status(500).json({ 
      status: "error", 
      error: error.message 
    });
  }
});

// -------------------- Get Vehicle Info Endpoint --------------------
app.get("/vehicle/:rfid", async (req, res) => {
  const { rfid } = req.params;
  const normalizedRfid = rfid.toLowerCase();
  
  try {
    const snapshot = await db.ref(`vehicles/${normalizedRfid}`).once("value");
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Vehicle not found" });
    }
    
    res.json({
      status: "success",
      vehicle: snapshot.val()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- Initialize Vehicle Endpoint --------------------
app.post("/vehicle/initialize", async (req, res) => {
  const { rfid, email, vehicleType = "car", ownerName } = req.body;
  
  if (!rfid) {
    return res.status(400).json({ error: "RFID is required" });
  }

  const normalizedRfid = rfid.toLowerCase();
  
  try {
    const vehicleRef = db.ref(`vehicles/${normalizedRfid}`);
    const initialData = {
      balance: 0,
      debt: 0,
      lastTopup: null,
      lastTopupAmount: 0,
      lastDeduction: null,
      email: email || rfidToEmail[normalizedRfid] || "",
      vehicleType: vehicleType,
      ownerName: ownerName || `Vehicle ${normalizedRfid}`,
      createdAt: new Date().toISOString()
    };

    await vehicleRef.set(initialData);

    // Initialize empty transactions node
    await db.ref(`transactions/${normalizedRfid}`).set({});

    console.log("✅ Vehicle initialized:", normalizedRfid);
    
    res.json({
      status: "success",
      message: "Vehicle initialized successfully",
      vehicle: initialData
    });
  } catch (error) {
    console.error("❌ Vehicle initialization failed:", error);
    res.status(500).json({ 
      status: "error", 
      error: error.message 
    });
  }
});

// -------------------- Test Endpoints --------------------
app.get("/test", (req, res) => {
  res.json({ 
    status: "✅ Server is running!", 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production',
    endpoints: {
      topup: "POST /esp32/topup",
      webhook: "POST /paystack/webhook", 
      manual_update: "POST /manual/update-balance",
      vehicle_info: "GET /vehicle/:rfid",
      initialize_vehicle: "POST /vehicle/initialize",
      test_vehicles: "GET /test/vehicles",
      health: "GET /health"
    },
    rfid_mapping: Object.keys(rfidToCustomer),
    email_mapping: rfidToEmail
  });
});

app.get("/test/vehicles", async (req, res) => {
  try {
    const snapshot = await db.ref("vehicles").once("value");
    const vehicles = snapshot.val();
    console.log("📊 Vehicles in database:", Object.keys(vehicles || {}));
    res.json(vehicles || {});
  } catch (error) {
    console.error("❌ Error fetching vehicles:", error);
    res.status(500).json({ error: error.message });
  }
});

// -------------------- Health Check --------------------
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "Automated Toll System API",
    version: "2.0",
    firebase: "connected",
    paystack: PAYSTACK_SECRET_KEY ? "configured" : "not configured"
  });
});

// -------------------- Error Handling --------------------
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err);
  res.status(500).json({ 
    status: "error", 
    message: "Internal server error",
    error: err.message 
  });
});

// -------------------- 404 Handler --------------------
app.use((req, res) => {
  res.status(404).json({ 
    status: "error", 
    message: "Endpoint not found",
    available_endpoints: [
      "POST /esp32/topup",
      "POST /paystack/webhook",
      "POST /manual/update-balance", 
      "GET /vehicle/:rfid",
      "POST /vehicle/initialize",
      "GET /test",
      "GET /test/vehicles",
      "GET /health"
    ]
  });
});

// -------------------- Start Express Server --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(50));
  console.log("🚀 AUTOMATED TOLL SYSTEM SERVER STARTED");
  console.log("=".repeat(50));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`🔑 RFID Tags Configured: ${Object.keys(rfidToCustomer).length}`);
  console.log(`📧 Email Mapping: ${Object.keys(rfidToEmail).length} vehicles`);
  console.log(`💳 Paystack: ${PAYSTACK_SECRET_KEY ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`🔔 IFTTT: ${IFTTT_KEY ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`🔥 Firebase: ✅ Connected`);
  console.log("\n📋 Available Endpoints:");
  console.log(`   💳 POST /esp32/topup     - Request top-up payment link`);
  console.log(`   📡 POST /paystack/webhook - Process payment notifications`);
  console.log(`   🔧 POST /manual/update-balance - Manual balance updates`);
  console.log(`   🚗 POST /vehicle/initialize - Initialize new vehicle`);
  console.log(`   ℹ  GET /vehicle/:rfid    - Get vehicle information`);
  console.log(`   🧪 GET /test             - Test server status`);
  console.log(`   🧪 GET /test/vehicles    - List all vehicles`);
  console.log(`   ❤  GET /health          - Health check`);
  console.log("=".repeat(50));
});

export default app;