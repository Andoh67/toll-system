import express from "express";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// Firebase Service Account
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

// Firebase Init
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

// Environment Variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const IFTTT_KEY = process.env.IFTTT_KEY;

// RFID → Paystack Customer Mapping
const rfidToCustomer = JSON.parse(process.env.RFID_MAPPING || '{"7a5a3d02":"CUS_nqf4gq1bbkwf2kx","937db7e4":"CUS_v4k17y3gstgxpbt","14973ca3":"CUS_wzphr3hmdh2is1q"}');

// Vehicle Email Mapping
const rfidToEmail = {
  "7a5a3d02": process.env.VEHICLE_7A5A3D02_EMAIL || "baffoestephen980@gmail.com",
  "937db7e4": process.env.VEHICLE_937DB7E4_EMAIL || "billionsblay233257@gmail.com",
  "14973ca3": process.env.VEHICLE_14973CA3_EMAIL || "mentorgabriel000@gmail.com"
};

console.log("🔑 Loaded RFID Mapping:", Object.keys(rfidToCustomer));
console.log("📧 Loaded Email Mapping:", rfidToEmail);

// IFTTT Webhook Helper
function sendIFTTTWebhook(eventName, value1, value2, value3, value4) {
  if (!IFTTT_KEY) {
    console.log("IFTTT key not configured");
    return;
  }
  const url = `http://maker.ifttt.com/trigger/${eventName}/with/key/${IFTTT_KEY}?value1=${value1}&value2=${value2}&value3=${value3}&value4=${value4}`;
  console.log(`🔔 Sending IFTTT: ${eventName} `, { value1, value2, value3, value4 });
  axios.get(url).catch(err => console.error("IFTTT error:", err.message));
}

// ===================== AUTOMATIC DEBT DEDUCTION =====================
async function processPendingDebt(rfid, paymentAmount) {
  try {
    console.log(`🔍 Checking for pending debt for RFID: ${rfid}`);
    
    const vehicleRef = db.ref(`vehicles/${rfid}`);
    const snapshot = await vehicleRef.once("value");
    
    if (!snapshot.exists()) {
      console.log("❌ No vehicle found for debt processing");
      return { processed: false, reason: "Vehicle not found" };
    }
    
    const vehicleData = snapshot.val();
    const currentDebt = vehicleData.debt || 0;
    const currentBalance = vehicleData.balance || 0;
    
    console.log(`📊 Debt Check - Balance: GH₵${currentBalance}, Debt: GH₵${currentDebt}`);
    
    if (currentDebt > 0) {
      console.log(`💰 Processing automatic debt deduction: GH₵${currentDebt}`);
      
      // Calculate how much debt we can clear
      const amountAvailable = currentBalance + paymentAmount;
      const debtToClear = Math.min(currentDebt, amountAvailable);
      const remainingDebt = currentDebt - debtToClear;
      const newBalance = amountAvailable - debtToClear;
      
      console.log(`🧮 Debt Calculation:`);
      console.log(`   Available: GH₵${amountAvailable}`);
      console.log(`   Debt to clear: GH₵${debtToClear}`);
      console.log(` Remaining debt: GH₵${remainingDebt} `);
      console.log(`   New balance: GH₵${newBalance} `);
      
      // Update vehicle data
      const updates = {
        balance: newBalance,
        debt: remainingDebt,
        lastDebtDeduction: new Date().toISOString(),
        lastAutoDeduction: new Date().toISOString()
      };
      
      await vehicleRef.update(updates);
      
      // Log the automatic debt deduction
      const transactionId = Date.now();
      const historyRef = db.ref(`transactions/${rfid}/${transactionId}`);
      await historyRef.set({
        type: "auto_debt_deduction",
        payment_amount: paymentAmount,
        debt_cleared: debtToClear,
        debt_remaining: remainingDebt,
        balance_before: currentBalance,
        balance_after: newBalance,
        debt_before: currentDebt,
        debt_after: remainingDebt,
        time: new Date().toISOString(),
        status: "completed",
        source: "automatic",
        note: "Automatic debt deduction after top-up"
      });
      
      console.log("✅ Automatic debt deduction completed successfully");
      
      // Send notification
      sendIFTTTWebhook(
        "toll_log",
        rfid,
        `AUTO-DEBT - Cleared: GH₵${debtToClear}`,
        `Remaining: GH₵${remainingDebt} | Balance: GH₵${newBalance}`,
        "Automatic debt deduction"
      );
      
      return {
        processed: true,
        debtCleared: debtToClear,
        remainingDebt: remainingDebt,
        newBalance: newBalance
      };
    } else {
      console.log("✅ No pending debt to process");
      return { processed: false, reason: "No debt" };
    }
  } catch (error) {
    console.error("❌ Error processing automatic debt:", error);
    return { processed: false, reason: error.message };
  }
}

// ===================== PAYSTACK TRANSACTION API =====================
async function createPaymentLink(rfid, customerId, amount) {
  try {
    console.log(`🔗 Creating transaction for RFID: ${rfid}, Customer: ${customerId}, Amount: GH₵${amount / 100}`);
    
    if (!PAYSTACK_SECRET_KEY) {
      console.error("❌ Paystack secret key not configured");
      return { status: "error", error: "Paystack secret key not configured" };
    }

    const customerEmail = rfidToEmail[rfid] || "baffoestephen980@gmail.com";
    
    // Use transaction API for better reliability
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: customerEmail,
        amount: amount,
        currency: "GHS",
        reference: `toll_${rfid}_${Date.now()}`,
        callback_url: "https://toll-system-o71i.onrender.com/paystack/webhook",
        metadata: {
          rfid: rfid,
          customer_id: customerId,
          purpose: "toll_topup",
          timestamp: new Date().toISOString(),
          vehicle_email: customerEmail
        },
        channels: ["card", "mobile_money", "bank"]
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    console.log("📡 Paystack Transaction API Response Status:", response.status);
    
    if (response.status === 200 && response.data && response.data.status === true) {
      const paymentData = response.data.data;
      console.log("✅ Transaction initialized successfully");
      
      if (paymentData.authorization_url) {
        console.log("🔗 Authorization URL:", paymentData.authorization_url);
        
        return {
          status: "success",
          amount: amount,
          link: paymentData.authorization_url,
          reference: paymentData.reference,
          message: "Payment link generated successfully"
        };
      } else {
        console.error("❌ No authorization URL in response");
        return { 
          status: "failed", 
          error: "No payment authorization URL received from Paystack",
          details: paymentData
        };
      }
    } else {
      console.error("❌ Paystack Transaction API returned error:");
      console.error("Response Status:", response.status);
      console.error("Response Data:", response.data);
      
      const errorMessage = response.data?.message || "Paystack Transaction API error";
      return { 
        status: "failed", 
        error: errorMessage,
        details: response.data
      };
    }
  } catch (err) {
    console.error("❌ Paystack transaction request error:");
    console.error("Error Message:", err.message);
    
    if (err.response) {
      console.error("Response Status:", err.response.status);
      console.error("Response Data:", err.response.data);
      
      return { 
        status: "error", 
        error: err.response.data?.message || `Paystack API error: ${err.response.status}`,
        details: err.response.data
      };
    } else if (err.request) {
      console.error("No response received from Paystack");
      return { 
        status: "error", 
        error: "No response from Paystack API - network issue"
      };
    } else {
      console.error("Request setup error:", err.message);
      return { 
        status: "error", 
        error: `Request setup error: ${err.message}`
      };
    }
  }
}

// ===================== ESP32 TOP-UP ENDPOINT =====================
app.post("/esp32/topup", async (req, res) => {
  console.log("\n" + "=".repeat(50));
  console.log("💳 TOP-UP REQUEST FROM ESP32");
  console.log("=".repeat(50));
  
  const { rfid, amount } = req.body;

  console.log(`📌 RFID: ${rfid}`);
  console.log(`💵 Amount: GH₵${amount / 100}`);
  console.log(`🔢 Amount in pesewas: ${amount}`);

  if (!rfid || !amount) {
    console.error("❌ Missing RFID or amount in request");
    return res.status(400).json({ 
      status: "failed", 
      error: "Missing RFID or amount" 
    });
  }

  const normalizedRfid = rfid.toLowerCase().trim();
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

  console.log("📊 Paystack Result Status:", result.status);
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
    
    // The ESP32 will now handle the Top_up_memberX notifications
    // We'll just log the debt notification here
    
    // Get current vehicle data for debt notification
    try {
      const vehicleRef = db.ref(`vehicles/${normalizedRfid}`);
      const snapshot = await vehicleRef.once("value");
      if (snapshot.exists()) {
        const vehicleData = snapshot.val();
        const currentDebt = vehicleData.debt || 0;
        
        // Send debt notification (information only - no payment link)
        let debtEventName = "Toll_debt_member1";
        if (normalizedRfid === "937db7e4") debtEventName = "Toll_debt_member2";
        else if (normalizedRfid === "14973ca3") debtEventName = "Toll_debt_member3";
        
        sendIFTTTWebhook(
          debtEventName,
          normalizedRfid,
          `Top-up required: GH₵${amount / 100}`,
          `Current debt: GH₵${currentDebt}`,
          "Payment link sent separately"
        );
      }
    } catch (error) {
      console.error("❌ Failed to send debt notification:", error);
    }
    
    // Return success response
    res.json({
      status: "success",
      amount: amount,
      link: result.link,
      reference: result.reference,
      message: "Payment link generated successfully"
    });
  } else {
    console.error("❌ Failed to create payment link:", result.error);
    
    // Return error response
    res.status(500).json({
      status: "failed",
      error: result.error || "Failed to create payment link",
      details: result.details
    });
  }
  
  console.log("=".repeat(50));
});

// ===================== PAYSTACK WEBHOOK =====================
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
        return res.status(400).send("No RFID in metadata");
      }

      const normalizedRfid = rfid.toLowerCase().trim();
      
      // STEP 1: Process any pending debt automatically FIRST
      console.log("🔄 STEP 1: Processing automatic debt deduction...");
      const debtResult = await processPendingDebt(normalizedRfid, amountPaid);
      
      // STEP 2: Process the normal top-up with remaining amount
      console.log("🔄 STEP 2: Processing top-up balance...");
      const vehicleRef = db.ref(`vehicles/${normalizedRfid}`);
      const snapshot = await vehicleRef.once("value");

      if (!snapshot.exists()) {
        console.error("❌ No vehicle found with RFID:", normalizedRfid);
        sendIFTTTWebhook(
          "toll_log",
          normalizedRfid,
          `GH₵${amountPaid}`,
          reference,
          "No vehicle linked to this RFID"
        );
        return res.status(404).json({ error: "Vehicle not found" });
      }

      const vehicleData = snapshot.val();
      
      // Use values from debt processing if available, otherwise use current values
      let currentBalance = debtResult.processed ? debtResult.newBalance : (vehicleData.balance || 0);
      let currentDebt = debtResult.processed ? debtResult.remainingDebt : (vehicleData.debt || 0);
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

      // If debt wasn't processed in step 1, clear debt now
      if (!debtResult.processed && currentDebt > 0) {
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

        // Force immediate sync by updating a sync field
        await new Promise(resolve => setTimeout(resolve, 500));
        await vehicleRef.update({ lastSync: new Date().toISOString() });

        console.log("✅ Firebase sync forced");

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
          customer_email: customerEmail,
          auto_debt_processed: debtResult.processed,
          debt_cleared_auto: debtResult.processed ? debtResult.debtCleared : 0
        });

        console.log("✅ Transaction logged successfully");

        // Send success notification using existing Toll_paid_memberX applets
        let eventName = "Toll_paid_member1";
        if (normalizedRfid === "937db7e4") eventName = "Toll_paid_member2";
        else if (normalizedRfid === "14973ca3") eventName = "Toll_paid_member3";
        
        if (currentDebt > 0) {
          const debtCleared = currentDebt - newDebt;
          sendIFTTTWebhook(
            eventName,
            normalizedRfid,
            `Top-up: GH₵${amountPaid} | Debt cleared: GH₵${debtCleared}`,
            `New Balance: GH₵${newBalance} | Remaining debt: GH₵${newDebt}`,
            `Reference: ${reference}`
          );
        } else {
          sendIFTTTWebhook(
            eventName,
            normalizedRfid,
            `Top-up: GH₵${amountPaid}`,
            `New Balance: GH₵${newBalance}`,
            `Reference: ${reference}`
          );
        }

        // Also log to Google Sheets
        sendIFTTTWebhook(
          "toll_log",
          normalizedRfid,
          `TOPUP_SUCCESS - GH₵${amountPaid}`,
          `Balance: GH₵${newBalance} | Debt: GH₵${newDebt}`,
          reference
        );

        console.log("✅ Webhook processed successfully");

      } catch (firebaseError) {
        console.error("❌ Firebase update error:", firebaseError);
        sendIFTTTWebhook(
          "toll_log",
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
        const normalizedRfid = rfid.toLowerCase().trim();
        
        sendIFTTTWebhook(
          "toll_log",
          normalizedRfid,
          `PAYMENT_FAILED - GH₵${event.data.amount / 100}`,
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

// ===================== MANUAL BALANCE UPDATE =====================
app.post("/manual/update-balance", async (req, res) => {
  console.log("\n" + "=".repeat(50));
  console.log("🔧 MANUAL BALANCE UPDATE");
  console.log("=".repeat(50));
  
  const { rfid, balance, debt } = req.body;

  console.log(`📌 RFID: ${rfid}`);
  console.log(`💵 Balance: GH₵${balance});
  console.log(📉 Debt: GH₵${debt}`);

  if (!rfid) {
    return res.status(400).json({ error: "RFID is required" });
  }

  try {
    const normalizedRfid = rfid.toLowerCase().trim();
    const vehicleRef = db.ref(`vehicles/${normalizedRfid}`);
    const snapshot = await vehicleRef.once("value");
    
    let updates = {};
    
    if (balance !== undefined) updates.balance = parseFloat(balance) || 0;
    if (debt !== undefined) updates.debt = parseFloat(debt) || 0;
    
    if (snapshot.exists()) {
      const existingData = snapshot.val();
      updates = {
        ...existingData,
        ...updates,
        last_manual_update: new Date().toISOString()
      };
    } else {
      updates = {
        balance: parseFloat(balance) || 0,
        debt: parseFloat(debt) || 0,
        lastTopup: null,
        lastTopupAmount: 0,
        lastDeduction: null,
        email: rfidToEmail[normalizedRfid] || "",
        vehicleType: "car",
        ownerName: `Vehicle ${normalizedRfid}`,
        createdAt: new Date().toISOString(),
        last_manual_update: new Date().toISOString()
      };
    }

    await vehicleRef.set(updates);

    console.log("✅ Manual update successful");
    console.log("📊 Updated vehicle data:", JSON.stringify(updates, null, 2));
    
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
      vehicle: updates
    });
  } catch (error) {
    console.error("❌ Manual update failed:", error);
    res.status(500).json({ 
      status: "error", 
      error: error.message 
    });
  }
});

// ===================== VEHICLE INFO ENDPOINT =====================
app.get("/vehicle/:rfid", async (req, res) => {
  const { rfid } = req.params;
  const normalizedRfid = rfid.toLowerCase().trim();
  
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

// ===================== INITIALIZE VEHICLE =====================
app.post("/vehicle/initialize", async (req, res) => {
  const { rfid, email, vehicleType = "car", ownerName } = req.body;
  
  if (!rfid) {
    return res.status(400).json({ error: "RFID is required" });
  }

  const normalizedRfid = rfid.toLowerCase().trim();
  
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

// ===================== SYSTEM STATUS ENDPOINT =====================
app.get("/system/status", async (req, res) => {
  try {
    const snapshot = await db.ref("system_status").once("value");
    const status = snapshot.val() || "System status not available";
    
    res.json({
      status: "success",
      system_status: status,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================== HEALTH CHECK =====================
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "Toll System API",
    version: "2.0.0"
  });
});

// ===================== ERROR HANDLING =====================
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({
    status: "error",
    error: "Internal server error",
    message: err.message
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    status: "error",
    error: "Endpoint not found"
  });
});

// ===================== SERVER STARTUP =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(50));
  console.log(`🚀 Toll System Server running on port ${PORT}`);
  console.log("=".repeat(50));
  console.log("📋 Available Endpoints:");
  console.log("   POST /esp32/topup          - ESP32 top-up requests");
  console.log("   POST /paystack/webhook     - Paystack payment webhook");
  console.log("   POST /manual/update-balance - Manual balance updates");
  console.log("   GET  /vehicle/:rfid        - Get vehicle info");
  console.log("   POST /vehicle/initialize   - Initialize new vehicle");
  console.log("   GET  /system/status        - System status");
  console.log("   GET  /health               - Health check");
  console.log("=".repeat(50));
});

export default app;