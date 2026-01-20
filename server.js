require('dotenv').config();

const express = require('express');
const app = express();
const cron = require('node-cron');
const { fork } = require('child_process');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const axios = require('axios');

const cors = require('cors');
const bodyParser = require('body-parser');
let Profiles;

const port = process.env.PORT || 5000;
const allowedOrigins = process.env.ALLOWED_ORIGINS.split(',');
const mongoUri = process.env.MONGODB_URI;

const server = require('http').createServer(app);

const io = require('socket.io')(server, {
  cors: {
    origin: process.env.SOCKET_ORIGIN.split(','),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const { MongoClient, ServerApiVersion } = require('mongodb');
const ioClient = require('socket.io-client');
const remoteSocketUrl =
  process.env.REMOTE_SOCKET_URL || 'http://localhost:5000';
const remoteSocket = ioClient(remoteSocketUrl);

// --- AES-256-CBC ENCRYPTION UTILS (matches main server) ---
const SMTP_SECRET = process.env.SMTP_SECRET || 'changeme!';
function getKey() {
  // Always return a Buffer of exactly 32 bytes
  return Buffer.alloc(32, SMTP_SECRET, 'utf8');
}
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}
function decrypt(text) {
  const [ivHex, encrypted] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(mongoUri, {
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
    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!',
    );
  } finally {
    // // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.use(express.static('public'));
app.use(express.json());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

// Helper function to handle post-emit logic for student creation
async function handleStudentCreatedPostEmit({
  db,
  matchedTeacher,
  memberName,
  userName,
  periodSegment,
  newAccount,
  io,
  res,
  date,
}) {
  // Add student to the correct period's students array (period object already exists)
  const periodStr = periodSegment; // Use string to preserve leading zeros
  const studentObj = { name: memberName, username: userName };
  // Log the teacher's periods array for debugging
  const teacherDoc = await db
    .collection('Teachers')
    .findOne({ _id: matchedTeacher._id });
  console.log(
    'Teacher periods before update:',
    JSON.stringify(teacherDoc.periods, null, 2),
  );
  // Try to push to the students array of the correct period
  const updateResult = await db
    .collection('Teachers')
    .updateOne(
      { _id: matchedTeacher._id, 'periods.period': periodStr },
      { $push: { 'periods.$.students': studentObj } },
    );
  console.log('Update result:', updateResult);
  if (updateResult.matchedCount === 0) {
    console.log('No matching period found for period:', periodStr);
  }
  // Emit studentAdded event for frontend
  io.emit('studentAdded', {
    memberName: newAccount.memberName,
    classPeriod: newAccount.classPeriod || periodStr,
    checkingBalance: newAccount.checkingAccount.balanceTotal,
    savingsBalance: newAccount.savingsAccount.balanceTotal,
    grade: newAccount.grade || null,
    lessonsCompleted: newAccount.lessonsCompleted || 0,
  });
  const redirectUrl = 'https://trinity-capital.net';
  io.emit('creationSuccesful', { account: newAccount, redirectUrl });
  res.status(201).json({ account: newAccount, redirectUrl });
}

// Helper function to emit events with acknowledgement
function emitWithAck(socket, event, data, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let called = false;
    const timer = setTimeout(() => {
      if (!called) {
        called = true;
        reject(new Error('Socket emit ack timeout'));
      }
    }, timeoutMs);
    socket.emit(event, data, ack => {
      if (!called) {
        called = true;
        clearTimeout(timer);
        resolve(ack);
      }
    });
  });
}

app.post('/createAccount', async (req, res) => {
  const db = client.db('TrinityCapital');
  const { parcel } = req.body;

  const firstName = parcel[0];
  const lastName = parcel[1];
  const accessCode = parcel[2];
  const date = parcel[3];
  const userName = parcel[4];
  const PIN = parcel[5];

  let numMin = 1000000000000000;
  let numMax = 9999999999999999;

  let accountNumCheck =
    Math.floor(Math.random() * (numMax - numMin + 1)) + numMin;
  let accountNumSav =
    Math.floor(Math.random() * (numMax - numMin + 1)) + numMin;

  const memberName = `${firstName} ${lastName}`;

  // Check for a legitimate access code before creating an account
  const modal = ` <dialog open class="baseModal">
<h1>Invalid or Used Access Code</h1>
<h1>Please Contact Admin</h1>
<button><a href="#" class="buttonClass">Close</a></button>
</dialog>`;

  // Student code parsing logic
  if (!accessCode) {
    io.emit('noSchoolCodeFound', modal);
    return res.status(400).json({ error: 'No access code provided' });
  }

  // If code is in the format US-NMHS-23A442C4-02
  const codeParts = accessCode.split('-');
  if (codeParts.length === 4) {
    const codeSegment = codeParts[2]; // 23A442C4
    const periodSegment = codeParts[3]; // 02
    // Find teacher by decrypting all teacher accessCodes and comparing
    const teachers = await db.collection('Teachers').find({}).toArray();
    let matchedTeacher = null;
    for (const teacher of teachers) {
      try {
        const decryptedCode = decrypt(teacher.accessCode);
        console.log(
          'Comparing:',
          codeSegment,
          'with decrypted:',
          decryptedCode,
        );
        if (codeSegment === decryptedCode) {
          matchedTeacher = teacher;
          break;
        }
      } catch (err) {
        console.warn('Failed to decrypt teacher accessCode:', err.message);
      }
    }
    if (!matchedTeacher) {
      io.emit('noSchoolCodeFound', modal);
      return res.status(400).json({ error: 'Invalid or used access code' });
    }
    let newAccount = {
      memberName: memberName,
      pin: parseInt(PIN),
      numberOfAccounts: 2,
      teacher: matchedTeacher.name,
      school: matchedTeacher.school,
      classPeriod: parseInt(periodSegment, 10),
      grade: 100,
      lessons: 0,
      checkingAccount: {
        routingNumber: 141257185,
        currency: 'USD',
        locale: 'en-US',
        created: `${date}`,
        accountHolder: memberName,
        balanceTotal: 0,
        bills: [],
        payments: [],
        accountType: 'Checking',
        accountNumber: accountNumCheck.toString(),
        movementsDates: [],
        transactions: [],
      },
      savingsAccount: {
        routingNumber: 141257185,
        currency: 'USD',
        locale: 'en-US',
        created: `${date}`,
        accountHolder: memberName,
        username: userName,
        balanceTotal: 0,
        bills: [],
        payments: [],
        accountType: 'Savings',
        accountNumber: accountNumSav.toString(),
        movementsDates: [],
        transactions: [],
      },
      userName: userName,
    };
    await db.collection('User Profiles').insertOne(newAccount);
    try {
      const ack = await emitWithAck(remoteSocket, 'studentCreated', newAccount);
      if (ack && ack.success) {
        console.log('Remote socket emit successful:', ack);
      } else {
        console.warn('Remote socket emit ack received but not success:', ack);
      }
      await handleStudentCreatedPostEmit({
        db,
        matchedTeacher,
        memberName,
        userName,
        periodSegment,
        newAccount,
        io,
        res,
        date,
      });
    } catch (err) {
      console.error('Remote socket emit failed:', err);
      res.status(500).json({ error: 'Socket emit failed' });
    }
    return;
  }

  // Check for a legitimate access code before creating an account
  let codes = await db.collection('Access Codes').findOne({ code: accessCode });
  if (codes === null) {
    // Broadcast error message
    io.emit('noSchoolCodeFound', modal);
    return res.status(400).json({ error: 'Invalid or used access code' });
  }
  // Check if this is a teacher code
  const isTeacher = codes.type === 'teacher';
  const redirectUrl = isTeacher
    ? 'https://teacher-dashboard.trinity-capital.net'
    : 'https://trinity-capital.net';

  // Extract teacher, school, and class period from the access code document
  const teacher = codes.teacher || '';
  const school = codes.school || '';
  const classPeriod = codes.classPeriod || '';

  if (isTeacher) {
    // Hash the PIN (one-way for security), encrypt access code (reversible)
    const hashedPin = crypto.createHash('sha256').update(PIN).digest('hex');
    const encryptedAccessCode = encrypt(accessCode);
    // Check if a teacher already exists with this access code
    const teachers = await db.collection('Teachers').find({}).toArray();
    for (const teacher of teachers) {
      try {
        const decryptedCode = decrypt(teacher.accessCode);
        if (decryptedCode === accessCode) {
          io.emit('noSchoolCodeFound', modal);
          return res.status(400).json({ error: 'Invalid or used access code' });
        }
      } catch (err) {
        console.warn('Failed to decrypt existing teacher code:', err.message);
      }
    }
    const teacherProfile = {
      name: memberName,
      accessCode: encryptedAccessCode,
      username: userName,
      pin: hashedPin,
      school: school,
    };
    await db.collection('Teachers').insertOne(teacherProfile);
    // Mark the access code as used
    await db
      .collection('Access Codes')
      .updateOne(
        { code: accessCode },
        { $set: { used: true, usedBy: userName, usedAt: new Date() } },
      );
    // --- OAuth2: Provide OAuth2 URL and isTeacher flag in response ---
    const oauth2Url = `${
      process.env.OAUTH2_AUTH_URL
    }?client_id=${encodeURIComponent(
      process.env.GOOGLE_CLIENT_ID,
    )}&redirect_uri=${encodeURIComponent(
      process.env.OAUTH2_REDIRECT_URI,
    )}&response_type=code&scope=${encodeURIComponent(
      'https://mail.google.com/',
    )}&access_type=offline&prompt=consent&state=${encodeURIComponent(
      userName,
    )}`;
    // Respond with OAuth2 URL for frontend to redirect
    return res.status(201).json({
      account: teacherProfile,
      redirectUrl,
      isTeacher: true,
      oauth2Url,
    });
  } else {
    let newAccount = {
      memberName: memberName,
      pin: parseInt(PIN),
      numberOfAccounts: 2,
      teacher: teacher,
      school: school,
      classPeriod: classPeriod,
      grade: 100,
      lessons: 0,
      checkingAccount: {
        routingNumber: 141257185,
        currency: 'USD',
        locale: 'en-US',
        created: `${date}`,
        accountHolder: memberName,
        balanceTotal: 0,
        bills: [],
        payments: [],
        accountType: 'Checking',
        accountNumber: accountNumCheck.toString(),
        movementsDates: [],
        transactions: [],
      },
      savingsAccount: {
        routingNumber: 141257185,
        currency: 'USD',
        locale: 'en-US',
        created: `${date}`,
        accountHolder: memberName,
        username: userName,
        balanceTotal: 0,
        bills: [],
        payments: [],
        accountType: 'Savings',
        accountNumber: accountNumSav.toString(),
        movementsDates: [],
        transactions: [],
      },
      userName: userName,
    };
    await db.collection('User Profiles').insertOne(newAccount);
    try {
      const ack = await emitWithAck(remoteSocket, 'studentCreated', newAccount);
      if (ack && ack.success) {
        console.log('Remote socket emit successful:', ack);
      } else {
        console.warn('Remote socket emit ack received but not success:', ack);
      }
      io.emit('creationSuccesful', { account: newAccount, redirectUrl });
      res.status(201).json({ account: newAccount, redirectUrl });
    } catch (err) {
      console.error('Remote socket emit failed:', err);
      res.status(500).json({ error: 'Socket emit failed' });
    }
    return;
  }
});

// Google OAuth2 callback handler
app.get('/oauth2/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state; // This is the teacher's username
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }
  try {
    // Exchange code for tokens
    const tokenResp = await axios.post(process.env.OAUTH2_TOKEN_URL, null, {
      params: {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.OAUTH2_REDIRECT_URI,
        grant_type: 'authorization_code',
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { access_token, refresh_token, id_token } = tokenResp.data;
    // Get teacher's email from Google
    const userResp = await axios.get(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${access_token}` },
      },
    );
    const email = userResp.data.email;
    // Store tokens and email in Teachers collection
    const db = client.db('TrinityCapital');
    await db.collection('Teachers').updateOne(
      { username: state },
      {
        $set: {
          oauth: {
            provider: 'google',
            email,
            access_token,
            refresh_token,
            id_token,
            token_obtained: new Date(),
          },
        },
      },
    );
    // Redirect to dashboard
    return res.redirect('https://trincapdash.netlify.app');
  } catch (err) {
    console.error('OAuth2 callback error:', err.response?.data || err.message);
    return res.status(500).send('OAuth2 setup failed. Please contact support.');
  }
});

// --- SEND EMAIL WITH TEACHER'S GOOGLE OAUTH2 ---
/* app.post('/sendEmail', async (req, res) => {
  const { sender, recipients, subject, message } = req.body;
  if (!sender || !recipients || !subject || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const db = client.db('TrinityCapital');
    const teacher = await db
      .collection('Teachers')
      .findOne({ username: sender });
    if (
      !teacher ||
      !teacher.oauth ||
      !teacher.oauth.email ||
      !teacher.oauth.refresh_token
    ) {
      return res
        .status(400)
        .json({ error: 'No OAuth2 credentials found for teacher' });
    }
    // Debug log for email sending
    console.log('SEND EMAIL DEBUG:');
    console.log('  teacher.oauth.email:', teacher.oauth.email);
    console.log('  teacher.oauth.refresh_token:', teacher.oauth.refresh_token);
    console.log('  teacher.oauth.access_token:', teacher.oauth.access_token);
    console.log('  teacher.oauth.id_token:', teacher.oauth.id_token);
    if (teacher.oauth.password) {
      console.log('  teacher.oauth.password:', teacher.oauth.password);
    }
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: teacher.oauth.email,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: teacher.oauth.refresh_token,
      },
    });
    await transporter.sendMail({
      from: teacher.oauth.email,
      to: recipients,
      subject,
      text: message,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('Send email error:', err);
    // Detect invalid credentials and prompt for re-auth
    const errMsg = err && err.message ? err.message : '';
    if (
      errMsg.includes('535') ||
      errMsg.includes('invalid_grant') ||
      errMsg.includes('Invalid Credentials')
    ) {
      return res.status(401).json({ error: 'oauth_reauth_required' });
    }
    return res.status(500).json({ error: 'Failed to send email' });
  }
}); */

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
