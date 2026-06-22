require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { createClient } = require("@supabase/supabase-js");
const input = require("input");

// ============================================
// CONFIGURATION
// ============================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Use service role to bypass RLS
);

const BOT_USERNAME = "patrickstarsrobot";
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;

// ============================================
// HELPER FUNCTIONS
// ============================================
function getRandomMinutes(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getNextClickerTime() {
  const mins = getRandomMinutes(6, 10);
  return new Date(Date.now() + mins * 60000);
}

function getNextDailyTime() {
  const hours = getRandomMinutes(1, 24);
  return new Date(Date.now() + hours * 60 * 60000);
}

// For first login, set clicker to run immediately (or in 1 minute)
function getInitialClickerTime() {
  return new Date(Date.now() + 60000); // 1 minute from now
}

// ============================================
// LOGIN FUNCTION
// ============================================
async function loginAccount() {
  console.log("\n╔════════════════════════════════════════════╗");
  console.log("║  🔐 TELEGRAM ACCOUNT LOGIN & SAVE         ║");
  console.log("╚════════════════════════════════════════════╝\n");

  const phone = await input.text("📱 Enter phone number (e.g., +1234567890): ");
  const instanceId = await input.text("🔢 Enter instance ID (1-12): ");

  const instance = parseInt(instanceId);
  if (instance < 1 || instance > 12) {
    console.log("❌ Invalid instance ID. Must be between 1 and 12.");
    return;
  }

  console.log("\n📡 Connecting to Telegram...");

  // Create client with empty session (will prompt for login)
  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  try {
    // Start with phone auth
    await client.start({
      phoneNumber: async () => phone,
      password: async () => {
        const pwd = await input.text("🔒 Enter 2FA password (or press Enter to skip): ");
        return pwd || undefined;
      },
      phoneCode: async () => {
        return await input.text("🔑 Enter verification code: ");
      },
      onError: (err) => console.log("⚠️  Error:", err),
    });

    console.log("✅ Successfully logged in!");

    // Get user info
    const me = await client.getMe();
    console.log(`\n👤 Account: ${me.firstName} ${me.lastName || ""}`);
    console.log(`   User ID: ${me.id}`);
    console.log(`   Username: @${me.username || "none"}`);

    // Test bot
    console.log(`\n🤖 Testing @${BOT_USERNAME}...`);
    try {
      await client.sendMessage(BOT_USERNAME, { message: "/start" });
      console.log("✅ Bot connection verified!");
    } catch (err) {
      console.log("⚠️  Could not test bot, but login successful");
    }

    // Export session
    const sessionString = client.session.save();
    console.log("\n🔑 Session string generated!");

    // Get next times
    const nextClicker = getInitialClickerTime(); // Start in 1 minute
    const nextDaily = getNextDailyTime();

    // Save to Supabase
    console.log("\n💾 Saving to Supabase...");
    const { data, error } = await supabase
      .from("accounts")
      .insert({
        instance_id: instance,
        user_id: me.id.toString(),
        phone: phone,
        session_string: sessionString,
        is_active: true,
        next_clicker_time: nextClicker.toISOString(),
        next_daily_time: nextDaily.toISOString(),
        error_count: 0,
        total_clicks: 0,
        total_dailies: 0,
      })
      .select();

    if (error) {
      console.error("\n❌ Supabase error:", error.message);
      console.log("\n📋 Manual SQL (if needed):");
      console.log(`
INSERT INTO accounts (instance_id, user_id, phone, session_string, is_active, next_clicker_time, next_daily_time)
VALUES (
  ${instance},
  '${me.id}',
  '${phone}',
  '${sessionString}',
  true,
  '${nextClicker.toISOString()}',
  '${nextDaily.toISOString()}'
);
      `);
    } else {
      console.log("\n✅ Account saved successfully!");
      console.log("\n📊 Details:");
      console.log(`   DB ID: ${data[0].id}`);
      console.log(`   Instance: ${instance}`);
      console.log(`   Next Clicker: ${nextClicker.toLocaleString()}`);
      console.log(`   Next Daily: ${nextDaily.toLocaleString()}`);
    }

    // Cleanup
    await client.destroy();
    console.log("\n👋 Disconnected from Telegram");
    console.log("\n✨ Login complete! You can now run the main worker.\n");
  } catch (error) {
    console.error("\n❌ Login failed:", error.message);
    
    try {
      await client.destroy();
    } catch (err) {
      // Ignore disconnect errors
    }
  }
}

// ============================================
// RUN
// ============================================
loginAccount()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });