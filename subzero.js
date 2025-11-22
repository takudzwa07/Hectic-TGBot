const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const YoutubeSearch = require('youtube-search-api');
const config = require('./config');

// Create bot instance
const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

// Store user states
const userStates = new Map();

// Utility Functions
const isYouTubeUrl = (text) => {
  return text.includes('youtube.com') || text.includes('youtu.be');
};

const extractVideoId = (url) => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
    /youtube\.com\/embed\/([^&\n?#]+)/,
    /youtube\.com\/v\/([^&\n?#]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
};

const formatDuration = (seconds) => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const formatViews = (views) => {
  if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
  if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
  return views.toString();
};

// Animate loading message
const animateLoading = async (chatId, messageId, text = 'Processing') => {
  let frame = 0;
  const interval = setInterval(async () => {
    try {
      await bot.editMessageText(
        `${config.LOADING_FRAMES[frame]} ${text}...`,
        { chat_id: chatId, message_id: messageId }
      );
      frame = (frame + 1) % config.LOADING_FRAMES.length;
    } catch (error) {
      clearInterval(interval);
    }
  }, 500);
  
  return interval;
};

// Fetch video info from API
const fetchVideoInfo = async (url) => {
  try {
    const response = await axios.get(`${config.API_URL}?url=${encodeURIComponent(url)}`, {
      timeout: 30000
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching video info:', error.message);
    return null;
  }
};

// Search YouTube
const searchYouTube = async (query) => {
  try {
    const results = await YoutubeSearch.GetListByKeyword(query, false, config.SEARCH_RESULTS_LIMIT);
    return results.items || [];
  } catch (error) {
    console.error('Error searching YouTube:', error.message);
    return [];
  }
};

// Create quality keyboard
const createQualityKeyboard = (videoData) => {
  const keyboard = [];
  
  // Audio option
  if (videoData.audio) {
    keyboard.push([{
      text: '🎵 Audio (MP3)',
      callback_data: `audio|${videoData.audio}`
    }]);
  }
  
  // Video quality options
  const videos = videoData.videos || {};
  const qualityOrder = ['144', '240', '360', '480', '720', '1080'];
  const videoButtons = [];
  
  for (const quality of qualityOrder) {
    if (videos[quality]) {
      videoButtons.push({
        text: `📹 ${quality}p`,
        callback_data: `video|${quality}|${videos[quality]}`
      });
    }
  }
  
  // Arrange in rows of 3
  for (let i = 0; i < videoButtons.length; i += 3) {
    keyboard.push(videoButtons.slice(i, i + 3));
  }
  
  // Cancel button
  keyboard.push([{ text: '❌ Cancel', callback_data: 'cancel' }]);
  
  return { inline_keyboard: keyboard };
};

// Delete messages after timeout
const scheduleDelete = async (chatId, messageIds, timeout = config.AUTO_DELETE_TIMEOUT) => {
  setTimeout(async () => {
    for (const msgId of messageIds) {
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (error) {
        // Message already deleted or not found
      }
    }
  }, timeout);
};

// Command Handlers
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, config.WELCOME_MESSAGE, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, config.HELP_MESSAGE, { parse_mode: 'Markdown' });
});

// Handle text messages (URLs or search queries)
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id;
    const text = msg.text.trim();
  
  // Check if user is in selection mode
  const userState = userStates.get(chatId);
  if (userState && userState.awaitingSelection) {
    const selection = parseInt(text);
    
    if (isNaN(selection) || selection < 1 || selection > userState.results.length) {
      await bot.sendMessage(chatId, '❌ Invalid selection. Please reply with a number between 1 and ' + userState.results.length);
      return;
    }
    
    const selectedVideo = userState.results[selection - 1];
    const videoUrl = `https://www.youtube.com/watch?v=${selectedVideo.id}`;
    
    // Clear user state
    userStates.delete(chatId);
    
    // Process the selected video
    await processVideoUrl(chatId, videoUrl, msg.message_id);
    return;
  }
  
  // Check if it's a YouTube URL
  if (isYouTubeUrl(text)) {
    await processVideoUrl(chatId, text, msg.message_id);
  } else {
    // It's a search query
    await processSearch(chatId, text, msg.message_id);
  }
  } catch (error) {
    console.error('Error processing message:', error);
    await bot.sendMessage(msg.chat.id, '❌ An error occurred while processing your request. Please try again.');
  }
});

// Process YouTube URL
const processVideoUrl = async (chatId, url, originalMsgId) => {
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Fetching video information...');
  const loadingInterval = animateLoading(chatId, loadingMsg.message_id, 'Fetching video info');
  
  const videoData = await fetchVideoInfo(url);
  clearInterval(loadingInterval);
  
  if (!videoData || !videoData.status) {
    await bot.editMessageText(
      `❌ *Error!*

Could not fetch video information. Please check:
• The URL is correct
• The video is publicly available
• The video is not age-restricted`,
      {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'Markdown'
      }
    );
    scheduleDelete(chatId, [loadingMsg.message_id, originalMsgId], 10000);
    return;
  }
  
  // Delete loading message
  await bot.deleteMessage(chatId, loadingMsg.message_id);
  
  // Send video info with quality options
  const caption = `📹 *${videoData.title}*

✅ Video found! Choose your preferred quality:

👨‍💻 *${config.BOT_NAME}*`;
  
  let selectionMsg;
  if (videoData.thumbnail) {
    try {
      selectionMsg = await bot.sendPhoto(chatId, videoData.thumbnail, {
        caption,
        parse_mode: 'Markdown',
        reply_markup: createQualityKeyboard(videoData)
      });
    } catch (error) {
      selectionMsg = await bot.sendMessage(chatId, caption, {
        parse_mode: 'Markdown',
        reply_markup: createQualityKeyboard(videoData)
      });
    }
  } else {
    selectionMsg = await bot.sendMessage(chatId, caption, {
      parse_mode: 'Markdown',
      reply_markup: createQualityKeyboard(videoData)
    });
  }
  
  // Store message IDs for cleanup
  userStates.set(chatId, {
    messagesToDelete: [originalMsgId, selectionMsg.message_id]
  });
};

// Process search query
const processSearch = async (chatId, query, originalMsgId) => {
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Searching YouTube...');
  const loadingInterval = animateLoading(chatId, loadingMsg.message_id, 'Searching');
  
  const results = await searchYouTube(query);
  clearInterval(loadingInterval);
  
  if (!results || results.length === 0) {
    await bot.editMessageText(
      '❌ No results found. Try a different search query.',
      { chat_id: chatId, message_id: loadingMsg.message_id }
    );
    scheduleDelete(chatId, [loadingMsg.message_id, originalMsgId], 10000);
    return;
  }
  
  // Delete loading message
  await bot.deleteMessage(chatId, loadingMsg.message_id);
  
  // Format search results
  let resultText = `🔍 *Search Results for:* "${query}"\n\n`;
  resultText += `Found ${results.length} results. Reply with a number (1-${results.length}) to select:\n\n`;
  
  results.forEach((video, index) => {
    const duration = video.length ? video.length.simpleText : 'N/A';
    const views = video.viewCount ? video.viewCount.text : 'N/A';
    const channel = video.channelTitle || 'Unknown';
    
    resultText += `*${index + 1}.* ${video.title}\n`;
    resultText += `   👤 ${channel}\n`;
    resultText += `   ⏱️ ${duration} | 👁️ ${views}\n\n`;
  });
  
  resultText += `_Reply with the number of your choice (e.g., "3")_\n\n`;
  resultText += `👨‍💻 *${config.BOT_NAME}*`;
  
  const searchMsg = await bot.sendMessage(chatId, resultText, {
    parse_mode: 'Markdown'
  });
  
  // Store search results and await user selection
  userStates.set(chatId, {
    awaitingSelection: true,
    results: results,
    messagesToDelete: [originalMsgId, searchMsg.message_id]
  });
  
  // Auto-delete after 60 seconds if no selection
  scheduleDelete(chatId, [originalMsgId, searchMsg.message_id]);
};

// Handle callback queries
bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    await bot.answerCallbackQuery(query.id);
  
  if (data === 'cancel') {
    await bot.editMessageText('❌ Download cancelled.', {
      chat_id: chatId,
      message_id: query.message.message_id
    });
    
    const userState = userStates.get(chatId);
    if (userState && userState.messagesToDelete) {
      scheduleDelete(chatId, [...userState.messagesToDelete, query.message.message_id], 3000);
    } else {
      scheduleDelete(chatId, [query.message.message_id], 3000);
    }
    userStates.delete(chatId);
    return;
  }
  
  if (data === 'done') {
    await bot.answerCallbackQuery(query.id, {
      text: '✅ Thank you for using HECTIC DOWNLOADER BOT!',
      show_alert: false
    });
    
    const userState = userStates.get(chatId);
    if (userState && userState.messagesToDelete) {
      await Promise.all([
        bot.deleteMessage(chatId, query.message.message_id),
        ...userState.messagesToDelete.map(id => bot.deleteMessage(chatId, id).catch(() => {}))
      ]);
    } else {
      await bot.deleteMessage(chatId, query.message.message_id);
    }
    userStates.delete(chatId);
    return;
  }
  
  // Parse download data
  const firstPipe = data.indexOf('|');
  const downloadType = data.substring(0, firstPipe);
  
  let downloadUrl, qualityText;
  if (downloadType === 'audio') {
    downloadUrl = data.substring(firstPipe + 1);
    qualityText = 'Audio (MP3)';
  } else {
    const secondPipe = data.indexOf('|', firstPipe + 1);
    const quality = data.substring(firstPipe + 1, secondPipe);
    downloadUrl = data.substring(secondPipe + 1);
    qualityText = `Video (${quality}p)`;
  }
  
  // Update message with download link
  const downloadText = `✅ *Ready to Download!*

📦 *Format:* ${qualityText}

Click the button below to download:

_This message will auto-delete in 60 seconds_

👨‍💻 *${config.BOT_NAME}*`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '📥 Download Now', url: downloadUrl }],
      [{ text: '✅ Done', callback_data: 'done' }]
    ]
  };
  
  try {
    if (query.message.photo) {
      await bot.editMessageCaption(downloadText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } else {
      await bot.editMessageText(downloadText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } catch (error) {
    console.error('Error editing message:', error.message);
  }
  
  // Auto-delete after 60 seconds
  const userState = userStates.get(chatId);
  if (userState && userState.messagesToDelete) {
    scheduleDelete(chatId, [...userState.messagesToDelete, query.message.message_id]);
  } else {
    scheduleDelete(chatId, [query.message.message_id]);
  }
  } catch (error) {
    console.error('Error in callback query handler:', error);
    await bot.answerCallbackQuery(query.id, {
      text: '❌ An error occurred. Please try again.',
      show_alert: true
    });
  }
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

console.log('🚀 HECTIC DOWNLOADER BOT is running...');
console.log('👨‍💻 Created by:', config.CREATOR);
