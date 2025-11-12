# Storage Setup Guide for Profile Pictures

## Quick Setup Steps

### 1. Create the Storage Bucket

1. Go to your **Supabase Dashboard**: https://supabase.com/dashboard
2. Select your project
3. Navigate to **Storage** (left sidebar)
4. Click **"New Bucket"** or **"Create Bucket"**
5. Fill in the form:
   - **Name**: `avatars` (exactly this name, lowercase)
   - **Public bucket**: ✅ **Check this box** (IMPORTANT!)
   - **File size limit**: 5 MB (or leave default)
   - **Allowed MIME types**: Leave empty or add `image/*`
6. Click **"Create bucket"**

### 2. Set Up Storage Policies (RLS)

After creating the bucket, you need to set up Row Level Security (RLS) policies:

1. Go to **Storage** → **Policies** tab
2. Select the `avatars` bucket
3. Click **"New Policy"**

#### Policy 1: Allow authenticated users to upload
- **Policy name**: `Allow authenticated users to upload avatars`
- **Allowed operation**: INSERT
- **Policy definition**:
```sql
bucket_id = 'avatars' AND auth.role() = 'authenticated'
```

#### Policy 2: Allow public to view avatars
- **Policy name**: `Allow public to view avatars`
- **Allowed operation**: SELECT
- **Policy definition**:
```sql
bucket_id = 'avatars'
```

#### Policy 3: Allow users to update their own avatars
- **Policy name**: `Allow users to update their own avatars`
- **Allowed operation**: UPDATE
- **Policy definition**:
```sql
bucket_id = 'avatars' AND auth.role() = 'authenticated' AND (storage.foldername(name))[1] = auth.uid()::text
```

#### Policy 4: Allow users to delete their own avatars
- **Policy name**: `Allow users to delete their own avatars`
- **Allowed operation**: DELETE
- **Policy definition**:
```sql
bucket_id = 'avatars' AND auth.role() = 'authenticated' AND (storage.foldername(name))[1] = auth.uid()::text
```

### 3. Verify Setup

After creating the bucket and policies:
1. Refresh your application
2. Try uploading a profile picture again
3. The upload should work now!

## Alternative: Use SQL to Create Policies

You can also run this SQL in the Supabase SQL Editor:

```sql
-- Create storage policies for avatars bucket
-- Note: The bucket must be created manually first in the Dashboard

-- Policy: Allow authenticated users to upload
CREATE POLICY "Allow authenticated users to upload avatars"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'avatars'
);

-- Policy: Allow public to view avatars
CREATE POLICY "Allow public to view avatars"
ON storage.objects
FOR SELECT
TO public
USING (
    bucket_id = 'avatars'
);

-- Policy: Allow users to update their own avatars
CREATE POLICY "Allow users to update their own avatars"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] = auth.uid()::text
);

-- Policy: Allow users to delete their own avatars
CREATE POLICY "Allow users to delete their own avatars"
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] = auth.uid()::text
);
```

## Troubleshooting

### Error: "Bucket not found"
- Make sure the bucket name is exactly `avatars` (lowercase)
- Check that the bucket exists in Storage → Buckets

### Error: "Permission denied" or "new row violates row-level security"
- Make sure you've created the RLS policies above
- Verify the bucket is set to **Public**

### Images not displaying
- Check that the bucket is **Public**
- Verify the file was uploaded successfully in Storage → avatars → files
- Check browser console for CORS errors

### Upload works but image doesn't show
- Clear browser cache
- Check that the `profile_picture_url` is being saved correctly in the database
- Verify the URL is publicly accessible

## File Structure

Files are stored in the bucket with this structure:
```
avatars/
  └── profiles/
      └── {user-id}-{timestamp}.{ext}
```

Example: `avatars/profiles/123e4567-e89b-12d3-a456-426614174000-1234567890.jpg`


