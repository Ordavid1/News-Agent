# Test Flow Instructions

## 1. Start the Server
```bash
npm start
```

## 2. Test the Flow

### Option A: Google OAuth (Mock)
1. Go to http://localhost:3000
2. Click any "Get Started" button
3. You should be redirected to http://localhost:3000/auth.html
4. Click "Continue with Google"
5. You should be automatically logged in and redirected to profile

### Option B: Email/Password
1. Go to http://localhost:3000
2. Click any "Get Started" button
3. You should be redirected to http://localhost:3000/auth.html
4. Enter any email (e.g., test@example.com)
5. Enter password: test123
6. Click "Sign In"
7. You should be logged in and redirected to profile

## 3. Complete Flow
1. After login, you're on profile page
2. Click "Start News Agent" button
3. You're on payment page - select any plan
4. Confirm test payment
5. You're redirected to settings page
6. Configure and save

## Pages URLs (for direct access)
- Home: http://localhost:3000/
- Auth: http://localhost:3000/auth.html
- Profile: http://localhost:3000/profile.html
- Payment: http://localhost:3000/payment.html
- Settings: http://localhost:3000/settings.html
- Demo: http://localhost:3000/demo.html

## Debugging
Open browser console (F12) to see any errors or logs.