// Vercel serverless function: Claude-powered sales pipeline assistant.
//
// The caller's Auth0 ID token is forwarded as the Supabase access token,
// so every query/write below is scoped by Row Level Security to the
// caller's tenant (clients.id == jwt client_id claim). The assistant has
// no way to read or modify another client's data.
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the AI sales assistant inside Simplí Solutions, a pipeline CRM for Irish SMEs.
You help the user understand and manage their sales pipeline (deals, tasks, comments).
Use the provided tools to look up real data before answering - never invent figures.
When asked to take an action (create a task, log a comment, move a deal's stage), call the
relevant tool. Currency values are in EUR. Be concise and practical.`;

const TOOLS = [
  {
    name: 'list_deals',
    description: 'List deals in the pipeline, optionally filtered by stage and/or owner.',
    input_schema: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: ['Awaiting PO', 'Verbal Confirmed', 'Negotiation', 'Survey', 'Quote'] },
        owner: { type: 'string' },
      },
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks, optionally filtered by status.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done'] },
      },
    },
  },
  {
    name: 'get_forecast_summary',
    description: 'Get pipeline totals and a breakdown by stage (count, total value, weighted value).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'flag_stale_deals',
    description: 'List deals that have not changed stage in at least threshold_days days.',
    input_schema: {
      type: 'object',
      properties: {
        threshold_days: { type: 'number', description: 'Minimum days in current stage. Defaults to 60.' },
      },
    },
  },
  {
    name: 'create_task',
    description: 'Create a new follow-up task.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        deal_id: { type: 'string', description: 'Optional related deal id.' },
        owner: { type: 'string' },
        due_date: { type: 'string', description: 'ISO date, e.g. 2026-06-20' },
        priority: { type: 'string', enum: ['Critical', 'High', 'Normal'] },
      },
      required: ['title'],
    },
  },
  {
    name: 'post_comment',
    description: 'Log an activity comment (call, email, note or alert) against a deal.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        type: { type: 'string', enum: ['Call', 'Email', 'Note', 'Alert'] },
        body: { type: 'string' },
      },
      required: ['deal_id', 'body'],
    },
  },
  {
    name: 'update_deal_stage',
    description: "Move a deal to a different pipeline stage (resets its 'time in stage' clock).",
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        stage: { type: 'string', enum: ['Awaiting PO', 'Verbal Confirmed', 'Negotiation', 'Survey', 'Quote'] },
      },
      required: ['deal_id', 'stage'],
    },
  },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const { message, history, author } = req.body || {};
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Missing "message"' });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const actions = [];

  async function execTool(name, input) {
    switch (name) {
      case 'list_deals': {
        let q = supabase
          .from('deals')
          .select('id,opportunity,company,stage,value,win_prob,weighted,owner,stage_changed_at,next_action,close_month');
        if (input.stage) q = q.eq('stage', input.stage);
        if (input.owner) q = q.eq('owner', input.owner);
        const { data, error } = await q;
        if (error) throw error;
        return data;
      }
      case 'list_tasks': {
        let q = supabase.from('tasks').select('id,title,owner,due_date,priority,status,deal_id');
        if (input.status) q = q.eq('status', input.status);
        const { data, error } = await q;
        if (error) throw error;
        return data;
      }
      case 'get_forecast_summary': {
        const { data, error } = await supabase.from('deals').select('stage,value,win_prob,weighted');
        if (error) throw error;
        const byStage = {};
        let totalValue = 0;
        let totalWeighted = 0;
        for (const d of data) {
          const s = (byStage[d.stage] ||= { count: 0, value: 0, weighted: 0 });
          s.count += 1;
          s.value += Number(d.value);
          s.weighted += Number(d.weighted);
          totalValue += Number(d.value);
          totalWeighted += Number(d.weighted);
        }
        return { totalValue, totalWeighted, byStage };
      }
      case 'flag_stale_deals': {
        const thresholdDays = input.threshold_days || 60;
        const { data, error } = await supabase
          .from('deals')
          .select('id,opportunity,company,stage,value,owner,stage_changed_at');
        if (error) throw error;
        const now = Date.now();
        return data
          .map((d) => ({ ...d, days_in_stage: Math.floor((now - new Date(d.stage_changed_at).getTime()) / 86400000) }))
          .filter((d) => d.days_in_stage >= thresholdDays)
          .sort((a, b) => b.days_in_stage - a.days_in_stage);
      }
      case 'create_task': {
        const { data, error } = await supabase
          .from('tasks')
          .insert({
            title: input.title,
            deal_id: input.deal_id || null,
            owner: input.owner || null,
            due_date: input.due_date || null,
            priority: input.priority || 'Normal',
          })
          .select()
          .single();
        if (error) throw error;
        actions.push({ type: 'task_created', task: data });
        return data;
      }
      case 'post_comment': {
        const { data, error } = await supabase
          .from('comments')
          .insert({
            deal_id: input.deal_id,
            author: author || 'AI Assistant',
            type: input.type || 'Note',
            body: input.body,
          })
          .select()
          .single();
        if (error) throw error;
        actions.push({ type: 'comment_posted', comment: data });
        return data;
      }
      case 'update_deal_stage': {
        const { data, error } = await supabase
          .from('deals')
          .update({ stage: input.stage, stage_changed_at: new Date().toISOString() })
          .eq('id', input.deal_id)
          .select()
          .single();
        if (error) throw error;
        actions.push({ type: 'deal_stage_updated', deal: data });
        return data;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  const messages = Array.isArray(history) ? [...history] : [];
  messages.push({ role: 'user', content: message });

  let finalText = '';
  try {
    for (let i = 0; i < 5; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        finalText = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        break;
      }

      const toolResults = [];
      for (const tu of toolUses) {
        try {
          const result = await execTool(tu.name, tu.input || {});
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
    return;
  }

  res.status(200).json({ reply: finalText || '(no response)', actions, history: messages });
}
