const express = require("express");
const app = express();
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// firebase admin
const admin = require("firebase-admin");

const serviceAccount = require("./firebase_verify_key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
//

const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

// traking id

function generateTrackingId() {
  const prefix = "PRCL";

  // Date as YYYYMMDD
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // Random 3-byte hex = 6 hex characters (e.g., A1F90C)
  const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${randomHex}`;
}

// middleware

app.use(express.json());
app.use(cors());

// verify token

const verifyFBToken = async (req, res, next) => {
  // console.log("header in the middleware", req.headers.authorization);
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
  } catch (error) {}
  next();
};

// mongodb

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vybtxro.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const zapShiftDB = client.db("zapShiftDB");
    const UserCollections = zapShiftDB.collection("users");
    const ParcelsCollections = zapShiftDB.collection("Parcels");
    const paymentCollections = zapShiftDB.collection("payments");
    const ridersCollections = zapShiftDB.collection("riders");

    // parcels api

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await UserCollections.findOne({ email });
      if (userExists) {
        return res.send({ message: "user exists" });
      }
      const result = await UserCollections.insertOne(user);
      res.send(result);
    });

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;

      if (email) {
        query.senderEmail = email;
      }

      const options = { sort: { createdAt: -1 } };
      const result = await ParcelsCollections.find(query, options).toArray();
      res.send(result);
    });

    // single parcel data
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await ParcelsCollections.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const data = req.body;
      data.createdAt = new Date();
      const result = await ParcelsCollections.insertOne(data);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await ParcelsCollections.deleteOne(query);
      res.send(result);
    });

    // payment related apis
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please pay for :${paymentInfo.parcelName} `,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
          trackingId: paymentInfo.trackingId,
        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // console.log("sesion retrive", session);
      // res.send({ message: true });

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollections.findOne(query);

      if (paymentExist) {
        return res.send({
          message: "already exist",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId,
          },
        };
        const result = await ParcelsCollections.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollections.insertOne(payment);
          return res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
          });
        }
        // res.send(result);
      }
      return res.send({ success: false });
    });

    // old
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      // console.log(session);
      res.send({ url: session.url });
    });

    // payment history realted apis

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      const headers = req.headers;
      console.log("headers", headers);

      if (email) {
        query.customerEmail = email;

        //cheack email adddress
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }
      const result = await paymentCollections
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    // riders releted apis

    app.get("/riders", async (req, res) => {
      const query = {};
      if (req.query.status) {
        query.status = req.query.status;
      }
      const result = await ridersCollections.find(query).toArray();
      res.send(result);
    });

    app.patch("/riders/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          status: status,
        },
      };
      const result = await ridersCollections.updateOne(query, update);

      if (status === "approved") {
        const email = req.body.email;
        const query = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await UserCollections.updateOne(query, updateUser);
      }
      res.send(result);
    });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createAt = new Date();
      const result = await ridersCollections.insertOne(rider);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "✅Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
