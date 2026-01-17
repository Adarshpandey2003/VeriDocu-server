import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import pool from './database.js';

passport.serializeUser((user, done) => {
  // Skip serialization for new users awaiting registration
  if (user.isNewUser) {
    return done(null, false);
  }
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, result.rows[0] || null);
  } catch (error) {
    done(error, null);
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user already exists with Google ID
        let userResult = await pool.query(
          'SELECT * FROM users WHERE google_id = $1',
          [profile.id]
        );

        if (userResult.rows.length > 0) {
          return done(null, userResult.rows[0]);
        }

        // Check if user exists with same email
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
        
        if (!email) {
          return done(new Error('No email provided by Google'), null);
        }

        userResult = await pool.query(
          'SELECT * FROM users WHERE email = $1',
          [email]
        );

        if (userResult.rows.length > 0) {
          // Link Google account to existing user
          const user = userResult.rows[0];
          
          await pool.query(
            'UPDATE users SET google_id = $1, profile_picture = $2 WHERE id = $3',
            [
              profile.id,
              profile.photos && profile.photos[0] ? profile.photos[0].value : null,
              user.id
            ]
          );
          
          // Fetch updated user
          const updatedResult = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
          return done(null, updatedResult.rows[0]);
        }

        // New user - return profile data with special flag for registration flow
        const userName = profile.displayName || 
          (profile.name ? [profile.name.givenName, profile.name.familyName].filter(Boolean).join(' ') : null) ||
          email.split('@')[0] || 
          'Unknown User';

        return done(null, {
          isNewUser: true,
          googleId: profile.id,
          email,
          name: userName,
          profilePicture: profile.photos && profile.photos[0] ? profile.photos[0].value : null
        });
      } catch (error) {
        console.error('❌ Google OAuth Error:', error);
        console.error('❌ Error stack:', error.stack);
        done(error, null);
      }
    }
  )
);

export default passport;
