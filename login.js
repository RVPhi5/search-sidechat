import { SidechatAPIClient } from "sidechat.js";
import { createInterface } from "readline";
import { writeFileSync, readFileSync, existsSync } from "fs";

const ENV_PATH = ".env";

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function saveTokenToEnv(token) {
  if (existsSync(ENV_PATH)) {
    let contents = readFileSync(ENV_PATH, "utf-8");
    if (contents.match(/^SIDECHAT_TOKEN=.*/m)) {
      contents = contents.replace(/^SIDECHAT_TOKEN=.*/m, `SIDECHAT_TOKEN=${token}`);
    } else {
      contents += `\nSIDECHAT_TOKEN=${token}`;
    }
    writeFileSync(ENV_PATH, contents);
  } else {
    writeFileSync(ENV_PATH, `SIDECHAT_TOKEN=${token}\nSIDECHAT_GROUP_ID=\n`);
  }
  console.log(`\nToken saved to ${ENV_PATH}`);
}

async function login() {
  const api = new SidechatAPIClient();

  console.log("=== Sidechat Login ===\n");

  const phone = await prompt("Phone number (10 digits, no country code): ");
  if (!/^\d{10}$/.test(phone)) {
    console.error("Invalid phone number. Enter 10 digits only (e.g. 5551234567).");
    process.exit(1);
  }

  console.log("Sending SMS...");
  const smsRes = await api.loginViaSMS(phone);

  if (smsRes?.error_code) {
    console.error(`Error: ${smsRes.message}`);
    process.exit(1);
  }

  console.log("SMS sent.\n");
  const code = await prompt("Enter the 6-digit code from your text: ");

  console.log("Verifying...");
  const verifyRes = await api.verifySMSCode(phone, code);

  if (verifyRes?.error_code) {
    console.error(`Error: ${verifyRes.message}`);
    process.exit(1);
  }

  if (verifyRes.logged_in_user) {
    const token = verifyRes.logged_in_user.token;
    console.log("\nLogged in successfully!");
    console.log(`Token: ${token}`);
    saveTokenToEnv(token);

    if (verifyRes.logged_in_user.group) {
      console.log(`\nDefault group: ${verifyRes.logged_in_user.group.name} (${verifyRes.logged_in_user.group.id})`);
    }

    await listGroups(token);
    return;
  }

  if (!verifyRes.registration_id) {
    console.error("Unexpected response from SMS verification.");
    process.exit(1);
  }

  const registrationID = verifyRes.registration_id;
  console.log("\nNew account detected. Need to verify age.\n");

  const age = await prompt("Enter your age: ");
  console.log("Setting age...");
  const ageRes = await api.setAge(parseInt(age, 10), registrationID);

  if (ageRes?.error_code) {
    console.error(`Error: ${ageRes.message}`);
    process.exit(1);
  }

  if (!ageRes.token) {
    console.error("Failed to get token after age verification.");
    process.exit(1);
  }

  api.setToken(ageRes.token);
  console.log("Age verified.\n");

  const email = await prompt("Enter your school (.edu) email: ");
  console.log("Registering email...");
  const emailRes = await api.registerEmail(email);

  if (emailRes?.error_code) {
    console.error(`Error: ${emailRes.message}`);
    process.exit(1);
  }

  console.log("\nVerification email sent. Click the link in your email, then press Enter here.");
  await prompt("Press Enter when done...");

  console.log("Checking verification...");
  const checkRes = await api.checkEmailVerification();

  if (checkRes?.error_code) {
    console.error(`Error: ${checkRes.message}`);
    process.exit(1);
  }

  if (!checkRes.token) {
    console.error("Email not verified yet. Try running login again after clicking the link.");
    process.exit(1);
  }

  const token = checkRes.token;
  console.log("\nFully registered and logged in!");
  console.log(`Token: ${token}`);
  saveTokenToEnv(token);

  await listGroups(token);
}

async function listGroups(token) {
  try {
    const api = new SidechatAPIClient(token);
    const updates = await api.getUpdates();
    if (updates.groups?.length) {
      console.log("\nYour groups:");
      for (const g of updates.groups) {
        console.log(`  ${g.id}  ${g.name}`);
      }
      console.log(`\nAdd your group ID to ${ENV_PATH} as SIDECHAT_GROUP_ID, then run: npm run scrape`);
    }
  } catch {}
}

login().catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
