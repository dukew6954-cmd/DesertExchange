# Supabase Setup Instructions

## 1. Create a Supabase Project

1. Go to https://supabase.com
2. Sign up or log in
3. Click "New Project"
4. Fill in your project details:
   - Name: `desert-exchange` (or your preferred name)
   - Database Password: (choose a strong password)
   - Region: (choose closest to you)
5. Wait for the project to be created (takes ~2 minutes)

## 2. Get Your Supabase Anon Key

1. In your Supabase project dashboard, go to **Settings** → **API**
2. Copy the **anon/public key** (starts with `eyJ...`)
   - This is the long string under "Project API keys" → "anon public"

## 3. Update app.js

Open `app.js` and replace line 6:

```javascript
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

With your actual anon key:

```javascript
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

**Note:** The Project URL has already been set to: `https://jzegylvfipujssamzqux.supabase.co`

## 4. Create Database Tables

Go to **SQL Editor** in your Supabase dashboard and run the SQL from `database_schema.sql` file.

**OR** copy and paste the complete SQL from the `database_schema.sql` file.

The complete schema includes:
- **events** - Main events
- **buy_sheets** - Buy sheet transactions
- **buy_list_items** - Individual items in buy list
- **sales** - Sales records
- **expenses** - Expense records
- **customers** - Customer CRM data
- **deleted_customers** - Soft-deleted customers
- **refineries** - Refinery exclusions
- **planned_events** - Event planning data
- **local_appointments** - Locally created appointments
- **completed_appointments** - Completed appointment tracking
- **route_planner_stops** - Route planner stops
- **live_prices_cache** - Cached live metal prices

All tables include:
- Row Level Security (RLS) policies
- Indexes for performance
- Automatic `updated_at` triggers
- Foreign key relationships

## 5. Test the Setup

1. Open your app in a browser
2. You should see a login/signup modal
3. Create a new account
4. Check your email for verification (if email confirmation is enabled)
5. Log in and test the app

## Next Steps

The app will now:
- Store all data in Supabase instead of localStorage
- Support multiple users with data isolation
- Persist data across devices
- Provide secure authentication

Note: You'll need to implement the data sync functions to replace localStorage calls with Supabase queries. This is a work in progress.

