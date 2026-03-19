require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient, ObjectId } = require('mongodb');

// ==================== KONFIGURATSIYA ====================
const token = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()));
const PRICE = process.env.PRICE || '37 000';
const CARD_NUMBER = process.env.CARD_NUMBER || '0000 0000 0000 0000';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'paymentbot';

// Botni ishga tushirish
const bot = new TelegramBot(token, { polling: true });

// ==================== MONGODB ULASH ====================
let db, usersCollection, paymentsCollection;

async function connectToMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  usersCollection = db.collection('users');
  paymentsCollection = db.collection('payments');
  console.log('MongoDB ga ulandi');
}
connectToMongo().catch(console.error);

// ==================== YORDAMCHI FUNKSIYALAR ====================
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function handleError(place, error) {
  console.error(`[ERROR] ${place}:`, error.message);
}

// HTML escape qilish (foydalanuvchi ma'lumotlarini xavfsiz ko'rsatish)
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Foydalanuvchi holatini vaqtincha saqlash (xotirada)
const userState = new Map(); // chatId -> 'awaiting_screenshot' | null

// ==================== MENYU TUGMALARI ====================
function getAdminMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '📋 Kutilayotgan to\'lovlar' }],
        [{ text: '📊 Statistika' }],
        // [{ text: '⬅️ Chiqish' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

function getUserMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '🛒 PREMIUM sotib olish' }],
        [{ text: '📞 Admin bilan bog\'lanish' }, { text: 'ℹ️ Yordam' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

// ==================== BUYRUQLAR ====================

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || '';
  const firstName = msg.from.first_name || '';

  try {
    // Foydalanuvchini bazaga qo'shish (upsert)
    await usersCollection.updateOne(
      { user_id: userId },
      {
        $setOnInsert: {
          user_id: userId,
          username: username,
          first_name: firstName,
          is_premium: false,
          created_at: new Date()
        }
      },
      { upsert: true }
    );

    const menu = isAdmin(userId) ? getAdminMenu() : getUserMenu();
    await bot.sendMessage(
      chatId,
      `Salom, ${escapeHtml(firstName)}!\nQuyidagi tugmalardan foydalaning.`,
      menu
    );
  } catch (error) {
    handleError('/start', error);
  }
});

// /buy (faqat oddiy foydalanuvchilar uchun, admin ham ishlatishi mumkin)
async function buyCommand(msg) {
  const chatId = msg.chat.id;
  const text = `
<b>🛒 PREMIUM versiya xaridi</b>

Narxi: <b>${escapeHtml(PRICE)} so'm</b>
Karta: <code>${escapeHtml(CARD_NUMBER)}</code>

To'lovni amalga oshirgandan so'ng, quyidagi tugmani bosing va chek rasmini hamda emailingizni yuboring.
  `;

  const opts = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ To\'lov qildim', callback_data: 'payment_done' }]
      ]
    }
  };

  try {
    await bot.sendMessage(chatId, text, opts);
  } catch (error) {
    handleError('/buy', error);
  }
}
bot.onText(/\/buy/, buyCommand);

// Callback query (inline tugmalar)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  try {
    // Foydalanuvchi "To'lov qildim" tugmasini bosdi
    if (data === 'payment_done') {
      userState.set(chatId, 'awaiting_screenshot');
      await bot.sendMessage(
        chatId,
        "Iltimos, chek rasmini va emailingizni bitta xabarda yuboring.\n\nMisol: rasm + email@example.com",
        { reply_markup: { remove_keyboard: true } }
      );
      await bot.answerCallbackQuery(query.id);
    }

    // Admin tasdiqlash/rad etish tugmalari
    else if (data.startsWith('accept_') || data.startsWith('reject_')) {
      if (!isAdmin(userId)) {
        return bot.answerCallbackQuery(query.id, { text: 'Siz admin emassiz!', show_alert: true });
      }

      const [action, paymentIdStr] = data.split('_');
      let objectId;
      try {
        objectId = new ObjectId(paymentIdStr);
      } catch (e) {
        return bot.answerCallbackQuery(query.id, { text: 'Noto\'g\'ri to\'lov ID', show_alert: true });
      }

      const payment = await paymentsCollection.findOne({ _id: objectId });
      if (!payment) {
        return bot.answerCallbackQuery(query.id, { text: 'To\'lov topilmadi!', show_alert: true });
      }

      if (action === 'accept') {
        await paymentsCollection.updateOne(
          { _id: objectId },
          { $set: { status: 'approved' } }
        );
        await usersCollection.updateOne(
          { user_id: payment.user_id },
          { $set: { is_premium: true } }
        );

        await bot.sendMessage(
          payment.user_id,
          '🎉 <b>To\'lov tasdiqlandi!</b>\nSizga PRO versiya berildi.',
          { parse_mode: 'HTML' }
        );

        // Admin xabaridagi tugmalarni olib tashlash
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        );

        await bot.answerCallbackQuery(query.id, { text: '✅ Tasdiqlandi' });
      } else if (action === 'reject') {
        await paymentsCollection.updateOne(
          { _id: objectId },
          { $set: { status: 'rejected' } }
        );

        await bot.sendMessage(
          payment.user_id,
          '❌ <b>To\'lov rad etildi.</b>\nIltimos, to\'lovni tekshirib qayta yuboring.',
          { parse_mode: 'HTML' }
        );

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        );

        await bot.answerCallbackQuery(query.id, { text: '❌ Rad etildi' });
      }
    }

    // Bekor qilish tugmasi (email xato bo'lganda)
    else if (data === 'cancel_payment') {
      userState.delete(chatId);
      await bot.deleteMessage(chatId, query.message.message_id);
      await bot.sendMessage(
        chatId,
        'Bekor qilindi.',
        isAdmin(userId) ? getAdminMenu() : getUserMenu()
      );
      await bot.answerCallbackQuery(query.id);
    }
  } catch (error) {
    handleError('callback_query', error);
  }
});

// Rasm (chek) qabul qilish
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  const photo = msg.photo;
  const fileId = photo[photo.length - 1].file_id;
  const caption = msg.caption || '';

  // Foydalanuvchi holatini tekshirish
  const state = userState.get(chatId);
  if (state !== 'awaiting_screenshot') {
    return bot.sendMessage(
      chatId,
      'Iltimos, avval /buy buyrug\'i orqali to\'lov jarayonini boshlang.',
      isAdmin(userId) ? getAdminMenu() : getUserMenu()
    );
  }

  // Emailni caption dan ajratish
  const email = caption.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    const opts = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Bekor qilish', callback_data: 'cancel_payment' }]
        ]
      }
    };
    return bot.sendMessage(
      chatId,
      '❌ Iltimos, rasmga <b>to‘g‘ri email</b> manzilini yozib qo‘ying.\nMisol: example@domain.com',
      opts
    );
  }

  try {
    // To'lov so'rovini bazaga qo'shish
    const result = await paymentsCollection.insertOne({
      user_id: userId,
      username: username,
      email: email,
      status: 'pending',
      created_at: new Date()
    });
    const paymentId = result.insertedId; // ObjectId

    // Foydalanuvchi holatini tozalash
    userState.delete(chatId);

    // Foydalanuvchiga xabar (asosiy menyu qaytariladi)
    await bot.sendMessage(
      chatId,
      '✅ <b>Chekingiz qabul qilindi.</b>\nAdmin tekshiruvidan so‘ng sizga xabar beramiz.',
      { parse_mode: 'HTML', reply_markup: getUserMenu() }
    );

    // Adminlarga rasmni yuborish (inline tugmalar bilan)
    const captionText = `
<b>Yangi to'lov cheki</b>

👤 Foydalanuvchi: @${escapeHtml(username)} (ID: ${userId})
📧 Email: ${escapeHtml(email)}
🆔 To'lov ID: <code>${paymentId.toString()}</code>
    `;

    const inlineKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Tasdiqlash', callback_data: `accept_${paymentId.toString()}` },
            { text: '❌ Rad etish', callback_data: `reject_${paymentId.toString()}` }
          ]
        ]
      }
    };

    // Har bir admin ga yuborish
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.sendPhoto(adminId, fileId, {
          caption: captionText,
          parse_mode: 'HTML',
          ...inlineKeyboard
        });
      } catch (e) {
        console.error(`Admin ${adminId} ga yuborishda xato:`, e.message);
      }
    }
  } catch (error) {
    handleError('photo', error);
    bot.sendMessage(chatId, 'Xatolik yuz berdi. Iltimos, qayta urinib ko\'ring.');
  }
});

// Matnli xabarlar (ReplyKeyboard tugmalari va boshqa matnlar)
bot.on('message', async (msg) => {
  if (msg.photo) return; // rasm xabarlarini o‘tkazib yuboramiz

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text) return;

  try {
    // Admin paneli
    if (isAdmin(userId)) {
      if (text === '📋 Kutilayotgan to\'lovlar') {
        const pendings = await paymentsCollection.find({ status: 'pending' })
          .sort({ created_at: -1 })
          .toArray();
        if (pendings.length === 0) {
          return bot.sendMessage(chatId, 'Kutilayotgan to\'lovlar yo‘q.', getAdminMenu());
        }
        let response = '<b>⏳ Kutilayotgan to\'lovlar:</b>\n\n';
        pendings.forEach(p => {
          const username = p.username ? escapeHtml(p.username) : p.user_id;
          const email = escapeHtml(p.email);
          response += `🆔 <code>${p._id.toString()}</code> | 👤 ${username} | 📧 ${email}\n`;
        });
        response += '\nTasdiqlash: /accept &lt;id&gt;\nRad etish: /reject &lt;id&gt;';
        await bot.sendMessage(chatId, response, { parse_mode: 'HTML', reply_markup: getAdminMenu() });
      }
      else if (text === '📊 Statistika') {
        const totalUsers = await usersCollection.countDocuments();
        const premiumUsers = await usersCollection.countDocuments({ is_premium: true });
        const totalPayments = await paymentsCollection.countDocuments();
        const approvedPayments = await paymentsCollection.countDocuments({ status: 'approved' });
        const pendingPayments = await paymentsCollection.countDocuments({ status: 'pending' });

        await bot.sendMessage(
          chatId,
          `<b>📊 Bot statistikasi</b>\n\n` +
          `👥 Jami foydalanuvchilar: ${totalUsers}\n` +
          `⭐ Premium foydalanuvchilar: ${premiumUsers}\n` +
          `💰 Jami to‘lovlar: ${totalPayments}\n` +
          `✅ Tasdiqlangan: ${approvedPayments}\n` +
          `⏳ Kutilayotgan: ${pendingPayments}`,
          { parse_mode: 'HTML', reply_markup: getAdminMenu() }
        );
      }
      else if (text === '⬅️ Chiqish') {
        await bot.sendMessage(chatId, 'Oddiy foydalanuvchi menyusiga o‘tdingiz.', getUserMenu());
      }
      else {
        // Admin boshqa matn yozsa, xabar beramiz
        await bot.sendMessage(chatId, 'Tushunarsiz buyruq. Admin menyusidagi tugmalardan foydalaning.', getAdminMenu());
      }
    } else {
      // Oddiy foydalanuvchi
      if (text === '🛒 PREMIUM sotib olish') {
        await buyCommand(msg);
      } else if (text === '📞 Admin bilan bog\'lanish') {
        await bot.sendMessage(chatId, 'Admin bilan bog‘lanish uchun @admin_username', getUserMenu());
      } else if (text === 'ℹ️ Yordam') {
        await bot.sendMessage(chatId, 'Botdan foydalanish: /start - asosiy menyu, /buy - PREMIUM xarid.', getUserMenu());
      } else {
        // Notanish matn
        await bot.sendMessage(chatId, 'Iltimos, quyidagi tugmalardan foydalaning:', getUserMenu());
      }
    }
  } catch (error) {
    handleError('message handler', error);
  }
});

// Admin uchun qo‘shimcha buyruqlar (matnli)
bot.onText(/\/pending/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  try {
    const pendings = await paymentsCollection.find({ status: 'pending' })
      .sort({ created_at: -1 })
      .toArray();
    if (pendings.length === 0) {
      return bot.sendMessage(msg.chat.id, 'Kutilayotgan to\'lovlar yo‘q.');
    }
    let response = '<b>⏳ Kutilayotgan to\'lovlar:</b>\n\n';
    pendings.forEach(p => {
      const username = p.username ? escapeHtml(p.username) : p.user_id;
      const email = escapeHtml(p.email);
      response += `🆔 <code>${p._id.toString()}</code> | 👤 ${username} | 📧 ${email}\n`;
    });
    response += '\nTasdiqlash: /accept <id>\nRad etish: /reject <id>';
    await bot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
  } catch (error) {
    handleError('/pending', error);
  }
});

bot.onText(/\/accept (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const paymentIdStr = match[1];
  let objectId;
  try {
    objectId = new ObjectId(paymentIdStr);
  } catch (e) {
    return bot.sendMessage(msg.chat.id, 'Noto\'g\'ri to\'lov ID formati.');
  }
  try {
    const payment = await paymentsCollection.findOne({ _id: objectId });
    if (!payment) {
      return bot.sendMessage(msg.chat.id, 'Bunday ID li to\'lov topilmadi.');
    }
    if (payment.status !== 'pending') {
      return bot.sendMessage(msg.chat.id, 'Bu to\'lov allaqachon ko\'rib chiqilgan.');
    }
    await paymentsCollection.updateOne({ _id: objectId }, { $set: { status: 'approved' } });
    await usersCollection.updateOne({ user_id: payment.user_id }, { $set: { is_premium: true } });
    await bot.sendMessage(payment.user_id, '🎉 <b>To\'lov tasdiqlandi!</b>\nSizga PRO versiya berildi.', { parse_mode: 'HTML' });
    await bot.sendMessage(msg.chat.id, `✅ To'lov ${paymentIdStr} tasdiqlandi.`);
  } catch (error) {
    handleError('/accept', error);
  }
});

bot.onText(/\/reject (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const paymentIdStr = match[1];
  let objectId;
  try {
    objectId = new ObjectId(paymentIdStr);
  } catch (e) {
    return bot.sendMessage(msg.chat.id, 'Noto\'g\'ri to\'lov ID formati.');
  }
  try {
    const payment = await paymentsCollection.findOne({ _id: objectId });
    if (!payment) {
      return bot.sendMessage(msg.chat.id, 'Bunday ID li to\'lov topilmadi.');
    }
    if (payment.status !== 'pending') {
      return bot.sendMessage(msg.chat.id, 'Bu to\'lov allaqachon ko\'rib chiqilgan.');
    }
    await paymentsCollection.updateOne({ _id: objectId }, { $set: { status: 'rejected' } });
    await bot.sendMessage(payment.user_id, '❌ <b>To\'lov rad etildi.</b>\nIltimos, to\'lovni tekshirib qayta yuboring.', { parse_mode: 'HTML' });
    await bot.sendMessage(msg.chat.id, `❌ To'lov ${paymentIdStr} rad etildi.`);
  } catch (error) {
    handleError('/reject', error);
  }
});

// ==================== XATOLARNI USHLASH ====================
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

console.log('Bot ishga tushdi...');