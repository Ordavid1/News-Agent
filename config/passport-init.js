import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { createUser, getUserByEmail, getUserById, updateUser } from '../services/database-wrapper.js';
import { v4 as uuidv4 } from 'uuid';

export function initializePassport() {
  // Only configure Google OAuth strategy if not in test mode or if credentials are provided
  if (process.env.TEST_MODE !== 'true' || (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID !== 'your-google-client-id')) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback"
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails[0].value;
          const name = profile.displayName;
          
          // Check if user exists
          let user = await getUserByEmail(email);
          
          if (user) {
            // Update last login
            await updateUser(user.id, { 
              lastLogin: new Date(),
              googleId: profile.id
            });
          } else {
            // Create new user
            user = await createUser({
              email,
              name,
              googleId: profile.id,
              apiKey: uuidv4(),
              role: 'user',
              authProvider: 'google'
            });
          }
          
          return done(null, user);
        } catch (error) {
          return done(error, null);
        }
      }
    ));
  }

  // Serialize user for session
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  // Deserialize user from session
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await getUserById(id);
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });

  return passport;
}