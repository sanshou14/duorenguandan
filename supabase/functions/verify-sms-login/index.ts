// Edge Function: verify-sms-login
// 验证 Mock 短信验证码，并用 service_role 生成 magic link token 返回给客户端
// 客户端用该 token 调用 supabase.auth.verifyOtp 完成登录
//
// 调用方式：supabase.functions.invoke('verify-sms-login', { body: { phone, code } })

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { phone, code } = await req.json();
    if (!phone || !code) throw new Error('缺少 phone 或 code');

    // 1. 查询最近一条未使用的有效验证码
    const { data: smsRecord, error: smsErr } = await supabaseAdmin
      .from('sms_codes')
      .select('*')
      .eq('phone', phone)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (smsErr || !smsRecord) {
      return new Response(
        JSON.stringify({ valid: false, error: '验证码无效或已过期，请重新发送' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 2. 校验验证码（Mock：固定 123456）
    if (smsRecord.code !== code) {
      return new Response(
        JSON.stringify({ valid: false, error: '验证码错误' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. 标记验证码为已使用
    await supabaseAdmin
      .from('sms_codes')
      .update({ used: true })
      .eq('id', smsRecord.id);

    // 4. 查询用户是否存在（以 phone@guandan.app 为 email）
    const email = `${phone}@guandan.app`;
    const { data: { users }, error: userErr } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = users?.find(u => u.email === email);

    if (!existingUser) {
      // 用户不存在：验证码已通过，返回成功供注册流程使用
      return new Response(
        JSON.stringify({ valid: true, is_new_user: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 5. 生成 magic link（recovery 类型），从中提取 hashed_token
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email
    });
    if (linkErr || !linkData) throw new Error('生成登录令牌失败');

    // hashed_token 供客户端调用 verifyOtp 使用
    const hashedToken = linkData.properties?.hashed_token;

    return new Response(
      JSON.stringify({ valid: true, is_new_user: false, hashed_token: hashedToken, email }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ valid: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
