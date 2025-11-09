require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN, // only if using socketMode
  socketMode: true
});

/** ===== OAuth2 (IDCS) ===== */
async function getOicToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: process.env.IDCS_SCOPE || 'urn:opc:resource:consumer::all'
  });
  const resp = await axios.post(process.env.IDCS_TOKEN_URL, params, {
    auth: { username: process.env.IDCS_CLIENT_ID, password: process.env.IDCS_CLIENT_SECRET },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });
  return resp.data.access_token;
}

/** ===== OIC call (GET with query params) ===== */
function buildOicBaseUrl() {
  // If you prefer building from code/version/resource, change this env var to your full REST trigger URL base.
  return `${process.env.OIC_REST_ENDPOINT}`;
}

async function callOic({ taskId, action, userEmail, comment, requestedBy }) {
  const token = await getOicToken();

  const qs = new URLSearchParams({
    taskid: String(taskId),
    action,
    npr: userEmail,
    comment,
    requestedBy
  });

  const fullUrl = `${buildOicBaseUrl()}?${qs.toString()}`;

  const resp = await axios.get(fullUrl, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000
  });

  return resp.data; // return only payload
}

/** ===== Helpers ===== */
const withoutActions = (blocks = []) => blocks.filter(b => b.type !== 'actions');

const withStatus = (blocks = [], text) => [
  ...blocks,
  { type: 'context', elements: [{ type: 'mrkdwn', text }] }
];

/** ===== Show modal on Approve/Reject click ===== */
async function openCommentModal({ ack, body, action, client, requireComment }) {
  await ack();

  const { taskId, action: decision, userEmail } = JSON.parse(action.value || '{}');

  // capture parent blocks WITHOUT buttons so we can remove them later
  const parentNoActions = withoutActions(body.message?.blocks || []);

  const privateMeta = {
    taskId, decision, userEmail,
    channelId: body.channel.id,
    messageTs: body.message.ts,
    clickedBy: body.user.id,
    parentNoActions
  };

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'approval_comment_view',
      private_metadata: JSON.stringify(privateMeta),
      title: { type: 'plain_text', text: 'Confirm Action' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `You are about to *${decision}* task *${taskId}*.` }
        },
        {
          type: 'input',
          block_id: 'comment_block',
          optional: !requireComment,
          label: { type: 'plain_text', text: requireComment ? 'Comment (required)' : 'Comment' },
          element: {
            type: 'plain_text_input',
            action_id: 'comment_input',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'Please Write Comment Here.' }
          }
        }
      ]
    }
  });
}

/** Register actions */
app.action('approve_invoice', async (ctx) => openCommentModal({ ...ctx, requireComment: false }));
app.action('reject_invoice',  async (ctx) => openCommentModal({ ...ctx, requireComment: true  }));
app.action('more_info_invoice',  async (ctx) => openCommentModal({ ...ctx, requireComment: true  }));

/** ===== Handle modal submission ===== */
app.view('approval_comment_view', async ({ ack, body, view, client, logger }) => {
  const meta = JSON.parse(view.private_metadata || '{}');
  const comment = (view.state.values?.comment_block?.comment_input?.value || '').trim();

  if ((meta.decision === 'REJECT' || meta.decision === 'INFO_REQUEST') && !comment) {
    await ack({
      response_action: 'errors',
      errors: { comment_block: 'Comment is required when rejecting.' }
    });
    return;
  }

  await ack(); // close modal

  // 1) post "processing…" reply and keep its ts
  let processing;
  try {
    processing = await client.chat.postMessage({
      channel: meta.channelId,
      thread_ts: meta.messageTs,
      text: `Please wait while we process *${meta.decision}* action for *${meta.taskId}* by <@${meta.clickedBy}>…`
    });
  } catch (e) {
    logger.warn('Pre-status reply failed: ' + e.message);
  }

  // 2) Call OIC
  try {
    const data = await callOic({
      taskId: meta.taskId,
      action: meta.decision,
      userEmail: meta.userEmail,
      comment,
      requestedBy: meta.clickedBy
    });

    const outcome = data?.status || data?.approvalOutcome || 'success';

 const statusRaw = (data?.Status ?? data?.status ?? data?.approvalOutcome ?? '').toString();
  const statusLC  = statusRaw.toLowerCase();
  const oicMsg    = (data?.Message ?? data?.message ?? '').toString();

   console.log('Status ' + statusLC);
   console.log('approvalOutcome ' + oicMsg);
  
   

  // build Slack texts based on status
  let threadText, parentStatus;
  if (statusLC === 'approved') {
    threadText   = `✅ Approved — ${oicMsg || 'success'}`;
    parentStatus = `✅ Approved by <@${meta.clickedBy}>`;
  } else if (statusLC === 'reject') {
    threadText   = `🚫 Rejected — ${oicMsg || 'Invoice rejected'}`;
    parentStatus = `🚫 Rejected by <@${meta.clickedBy}>`;
  }

 else if (statusLC === 'withdrawn') {
    threadText   = `ℹ️ Withdrawn — ${oicMsg || ''}`;
    parentStatus = `ℹ️ Withdrawn - The task is already completed by someone from approver group.`;
  }

else if (statusLC === 'moreinfo') {
    threadText   = `ℹ️ Requested more info — ${oicMsg || ''}`;
    parentStatus = `ℹ️ Requested more info - ${oicMsg || ''}`;
  }
  
    else {
    // fallback for any other status
    threadText   = `ℹ️ Result: *${statusRaw || 'unknown'}*${oicMsg ? ` — ${oicMsg}` : ''}`;
    parentStatus = `ℹ️ ${statusRaw || 'Completed'} by <@${meta.clickedBy}>`;
  }

  // 3a) edit the same thread reply with the final status
  if (processing?.ts) {
    await client.chat.update({
      channel: meta.channelId,
      ts: processing.ts,
      text: threadText
    });
  } else {
    await client.chat.postMessage({
      channel: meta.channelId,
      thread_ts: meta.messageTs,
      text: threadText
    });
  }

  // 3b) remove buttons on the parent and append a small status line
  await client.chat.update({
    channel: meta.channelId,
    ts: meta.messageTs,
    blocks: withStatus(
      meta.parentNoActions || [],
      parentStatus
    )
  });

 } catch (e) {
  const errText = e.response?.data?.message || e.message || 'Unknown error';
  if (processing?.ts) {
    await client.chat.update({
      channel: meta.channelId,
      ts: processing.ts,
      text: `❌ *${meta.decision}* failed for *${meta.taskId}*: ${errText}`
    });
  } else {
    await client.chat.postMessage({
      channel: meta.channelId,
      thread_ts: meta.messageTs,
      text: `❌ *${meta.decision}* failed for *${meta.taskId}*: ${errText}`
    });
  }
  logger.error('OIC call failed: ' + errText);
}
});

/** Start */
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡ Bolt app running');
})();
