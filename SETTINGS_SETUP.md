# Settings Page Setup

## Database Setup

1. Run the SQL migration file `settings_schema.sql` in your Supabase SQL Editor to create:
   - `user_profiles` table (stores user profile data, roles, profile pictures)
   - `roles` table (stores custom roles and permissions)

2. Create Storage Bucket for Avatars:
   - Go to Supabase Dashboard → Storage
   - Click "Create Bucket"
   - Name: `avatars`
   - Make it Public: Yes
   - Click "Create"

3. Set First Admin (Optional):
   - After running the SQL, manually set the first user as admin:
   ```sql
   UPDATE user_profiles 
   SET role = 'admin' 
   WHERE user_id = 'YOUR_USER_ID';
   ```

## Features Implemented

### 1. Profile Management
- ✅ Edit full name
- ✅ View email (read-only)
- ✅ Upload profile picture
- ✅ Profile picture displays in dashboard welcome message
- ✅ Initials shown if no profile picture

### 2. Admin Management (Admin Only)
- ✅ View all admins/managers
- ✅ Add new admins (users must sign up first)
- ✅ Remove admin privileges
- ✅ Role badges (admin, manager, user)

### 3. Roles Management (Admin Only)
- ✅ View all roles
- ✅ Create custom roles with permissions
- ✅ Delete roles
- ✅ Permission checkboxes:
  - View Dashboard
  - Manage Events
  - Manage Sales
  - Manage Expenses
  - Manage Customers
  - View Reports
  - Manage Admins

### 4. Dashboard Welcome Message
- ✅ Personalized "Welcome Back, [Name]!" message
- ✅ Shows profile picture or initials
- ✅ Updates automatically when profile is saved

## Usage

1. **Access Settings**: Click the "Settings" tab in the navigation
2. **Edit Profile**: Update your name and upload a profile picture
3. **Admin Features**: If you're an admin, you'll see Admin Management and Roles Management sections
4. **Add Admins**: Click "Add Admin" and enter the user's email (they must have signed up first)

## Notes

- Profile pictures are stored in Supabase Storage (avatars bucket)
- Maximum image size: 5MB
- Supported formats: All image formats
- Roles are stored in the `roles` table
- User roles are stored in `user_profiles.role` column

