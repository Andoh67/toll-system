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
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || "https://automated-toll-system-c2f6c-default-rtdb.firebaseio.com/"
});
const db = admin.database();


// -------------------- Environment Variables --------------------
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const IFTTT_KEY = process.env.IFTTT_KEY;

// -------------------- RFID → Paystack Customer Mapping --------------------
const rfidToCustomer = JSON.parse(process.env.RFID_MAPPING || '{"7a5a3d02":"CUS_nqf4gq1bbkwf2kx","937db7e4":"CUS_v4k17y3gstgxpbt","14973ca3":"CUS_wzphr3hmdh2is1q"}');

// -------------------- IFTTT Webhook Helper --------------------
function sendIFTTTWebhook(eventName, value1, value2, value3, value4) {
  if (!IFTTT_KEY) {
    console.log("IFTTT key not configured");
    return;
  }
  const url = `http://maker.ifttt.com/trigger/${eventName}/with/key/${IFTTT_KEY}?value1=${value1}&value2=${value2}&value3=${value3}&value4=${value4}`;
  axios.get(url).catch(err => console.error("IFTTT error:", err.message));
}

// -------------------- Paystack Top-up Link Generator --------------------
async function createPaymentLink(rfid, customerId, amount) {
  try {
    console.log(`🔗 Creating payment link for RFID: ${rfid}, Amount: ₵${amount / 100}`);
    
    const response = await axios.post(
      "https://api.paystack.co/paymentrequest",
      {
        customer: customerId,
        amount: amount,
        currency: "GHS",
        description: `Toll system top-up for RFID ${rfid}`,
        metadata: {
          rfid: rfid,
          purpose: "toll_topup"
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (response.data && response.data.status) {
      console.log("✅ Payment link created successfully");
      return {
        status: "success",
        amount: amount,
        link: response.data.data.link || response.data.data.hosted_link,
        reference: response.data.data.reference
      };
    } else {
      console.error("❌ Paystack API error:", response.data);
      return { status: "failed", error: response.data };
    }
  } catch (err) {
    console.error("❌ Paystack request error:", err.response?.data || err.message);
    return { status: "error", error: err.response ? err.response.data : err.message };
  }
}

// -------------------- ESP32 Endpoint: Request Top-up --------------------
app.post("/esp32/topup", async (req, res) => {
  const { rfid, amount } = req.body;

  console.log("\n========== 💳 Top-up Request from ESP32 ==========");
  console.log(`📌 RFID: ${rfid}`);
  console.log(`💵 Amount: ₵${amount / 100}`);

  const normalizedRfid = rfid.toLowerCase();
  
  if (!rfidToCustomer[normalizedRfid]) {
    console.error("❌ Unknown RFID:", normalizedRfid);
    return res.status(400).json({ 
      status: "failed", 
      error: `Unknown RFID: ${rfid}. Please register this tag.` 
    });
  }

  const customerId = rfidToCustomer[normalizedRfid];
  const result = await createPaymentLink(normalizedRfid, customerId, amount);

  if (result.status === "success") {
    console.log("✅ Payment link created:", result.link);
    
    sendIFTTTWebhook(
      "topup_requested",
      normalizedRfid,
      `₵${amount / 100}`,
      result.link,
      "Payment link generated"
    );
    
    res.json(result);
  } else {
    console.error("❌ Failed to create payment link:", result.error);
    
    sendIFTTTWebhook(
      "topup_error",
      normalizedRfid,
      `₵${amount / 100}`,
      result.error.message || "Unknown error",
      "Failed to generate payment link"
    );
    
    res.status(500).json(result);
  }
});

// -------------------- Webhook for Paystack (Debt Clearing) --------------------
app.post("/paystack/webhook", async (req, res) => {
  console.log("\n========== 📡 Incoming Webhook from Paystack ==========");
  
  try {
    const event = req.body;
    console.log("📥 Event:", event.event);

    if (event.event === "charge.success") {
      const email = event.data.customer.email;
      const amountPaid = event.data.amount / 100;
      const timestamp = new Date().toISOString();
      const reference = event.data.reference;

      console.log("💰 Payment Successful!");
      console.log(`👤 Customer Email: ${email}`);
      console.log(`💵 Amount Paid: GH₵${amountPaid}`);
      console.log(`🔢 Reference: ${reference}`);
      console.log(`⏰ Time: ${timestamp}`);

      const vehiclesRef = db.ref("vehicles");
      const snapshot = await vehiclesRef.once("value");
      let vehicleFound = false;

      snapshot.forEach(async (child) => {
        if (child.val().email === email) {
          vehicleFound = true;
          const vehicleId = child.key;
          const currentBalance = child.val().balance || 0;
          const currentDebt = child.val().debt || 0;

          console.log(`🚗 Vehicle Found: ${vehicleId}`);
          console.log(`💳 Current Balance: GH₵${currentBalance}`);
          console.log(`📉 Current Debt: GH₵${currentDebt}`);

          let remainingAmount = amountPaid;
          let newDebt = currentDebt;
          let newBalance = currentBalance;

          if (currentDebt > 0) {
            if (remainingAmount >= currentDebt) {
              remainingAmount -= currentDebt;
              newDebt = 0;
              console.log(`✅ Debt cleared: GH₵${currentDebt}`);
            } else {
              newDebt = currentDebt - remainingAmount;
              remainingAmount = 0;
              console.log(`✅ Partial debt cleared: GH₵${currentDebt - newDebt}, Remaining debt: GH₵${newDebt}`);
            }
          }

          if (remainingAmount > 0) {
            newBalance = currentBalance + remainingAmount;
            console.log(`💰 Added to balance: GH₵${remainingAmount}`);
          }

          console.log(`💳 New Balance: GH₵${newBalance}`);
          console.log(`📉 New Debt: GH₵${newDebt}`);

          try {
            await db.ref(`vehicles/${vehicleId}/balance`).set(newBalance);
            await db.ref(`vehicles/${vehicleId}/debt`).set(newDebt);

            const historyRef = db.ref(`transactions/${vehicleId}`).push();
            await historyRef.set({
              amount: amountPaid,
              balance_after: newBalance,
              debt_after: newDebt,
              debt_cleared: currentDebt - newDebt,
              time: timestamp,
              source: "Paystack Top-up",
              reference: reference,
              type: "topup"
            });

            console.log("✅ Firebase updated successfully");

            if (currentDebt > 0) {
              sendIFTTTWebhook(
                "debt_cleared",
                vehicleId,
                `GH₵${currentDebt - newDebt}`,
                `GH₵${newBalance}`,
                `Remaining debt: GH₵${newDebt}`
              );
            } else {
              sendIFTTTWebhook(
                "topup_completed",
                vehicleId,
                `GH₵${amountPaid}`,
                `GH₵${newBalance}`,
                reference
              );
            }

          } catch (firebaseError) {
            console.error("❌ Firebase update error:", firebaseError);
          }
        }
      });

      if (!vehicleFound) {
        console.error("❌ No vehicle found with email:", email);
        sendIFTTTWebhook(
          "unknown_topup",
          email,
          `GH₵${amountPaid}`,
          reference,
          "No vehicle linked to this email"
        );
      }
    }

    res.sendStatus(200);
    console.log("✅ Webhook processed successfully.");
    console.log("=======================================================");
    
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    res.sendStatus(500);
  }
});

// -------------------- Test Endpoints --------------------
app.get("/test", (req, res) => {
  res.json({ 
    status: "✅ Server is running!", 
    timestamp: new Date().toISOString(),
    endpoints: {
      topup: "/esp32/topup",
      webhook: "/paystack/webhook"
    }
  });
});

app.get("/test/vehicles", async (req, res) => {
  try {
    const snapshot = await db.ref("vehicles").once("value");
    res.json(snapshot.val());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- Start Express Server --------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("===============================================");
  console.log(`🚀 Node.js Server running on port ${PORT}`);
  console.log(`📌 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log("===============================================");
});