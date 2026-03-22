-- 003_avatar_storage.sql
-- 为 avatars Storage bucket 配置 RLS 策略
-- 需在 Supabase Dashboard → SQL Editor 中手动执行

-- 确保 avatars bucket 存在且为公开
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 认证用户可上传到自己的文件夹（路径格式: {user_id}/avatar.jpg）
DROP POLICY IF EXISTS "avatar_insert" ON storage.objects;
CREATE POLICY "avatar_insert" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'avatars' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- 认证用户可覆盖自己的头像（upsert: true 走 UPDATE 路径）
DROP POLICY IF EXISTS "avatar_update" ON storage.objects;
CREATE POLICY "avatar_update" ON storage.objects
FOR UPDATE USING (
  bucket_id = 'avatars' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- 所有人可读（公开头像）
DROP POLICY IF EXISTS "avatar_select" ON storage.objects;
CREATE POLICY "avatar_select" ON storage.objects
FOR SELECT USING (bucket_id = 'avatars');
