import * as React from 'react';
import { useNavigate } from "react-router-dom"; 
import Avatar from '@mui/material/Avatar';
import Button from '@mui/material/Button';
import CssBaseline from '@mui/material/CssBaseline';
import TextField from '@mui/material/TextField';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import Typography from '@mui/material/Typography';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { AuthContext } from '../contexts/AuthContext';
import Snackbar from '@mui/material/Snackbar';
import '../styles/authentication.css';

const defaultTheme = createTheme({
  palette: {
    primary: { main: '#0096ff' },
    secondary: { main: '#00d4ff' },
  },
  typography: {
    fontFamily: `'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial`,
  },
});

export default function Authentication() {
  const navigate = useNavigate(); // ✅ added

  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [formState, setFormState] = React.useState(0);
  const [open, setOpen] = React.useState(false);

  const { handleRegister, handleLogin } = React.useContext(AuthContext);

  const handleAuth = async (e) => {
    e.preventDefault();

    try {
      if (formState === 0) {
        // 🔥 LOGIN
        await handleLogin(username, password);

        // ✅ SAFE NAVIGATION (NO reload)
        navigate("/home", { replace: true });

      } else {
        // 🔥 REGISTER
        const result = await handleRegister(name, username, password);

        setUsername("");
        setPassword("");
        setName("");
        setMessage(result || "Registered successfully");
        setOpen(true);
        setError("");
        setFormState(0);
      }
    } catch (err) {
      const msg = err?.response?.data?.message || "Something went wrong";
      setError(msg);
    }
  };

  return (
    <ThemeProvider theme={defaultTheme}>
      <Grid container component="main" className="auth-root">
        <CssBaseline />

        {/* Left hero image */}
        <Grid
          item xs={false} sm={4} md={5}
          className="auth-hero"
          sx={{
            backgroundImage:
              'url(https://images.unsplash.com/photo-1504384308090-c894fdcc538d?q=80&w=1600&auto=format&fit=crop)',
          }}
        />

        {/* Right form */}
        <Grid
          item xs={12}
          sm={8}
          md={7}
          component={Paper}
          elevation={0}
          square
          className="auth-panel"
        >
          <Box className="auth-box">
            <Avatar className="auth-avatar" sx={{ bgcolor: 'primary.main' }}>
              <LockOutlinedIcon />
            </Avatar>

            <Typography component="h1" variant="h5" className="auth-title">
              {formState === 0 ? "Sign In" : "Create an Account"}
            </Typography>

            <Box className="auth-toggle">
              <Button
                variant={formState === 0 ? "contained" : "outlined"}
                onClick={() => setFormState(0)}
              >
                Sign In
              </Button>
              <Button
                variant={formState === 1 ? "contained" : "outlined"}
                onClick={() => setFormState(1)}
              >
                Sign Up
              </Button>
            </Box>

            {/* FORM */}
            <Box
              component="form"
              noValidate
              onSubmit={handleAuth}
              sx={{ mt: 1, width: '100%' }}
            >
              {formState === 1 && (
                <TextField
                  margin="normal"
                  required
                  fullWidth
                  label="Full Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  variant="outlined"
                  className="auth-input"
                  autoComplete="name"
                />
              )}

              <TextField
                margin="normal"
                required
                fullWidth
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                variant="outlined"
                className="auth-input"
                autoComplete="username"
              />

              <TextField
                margin="normal"
                required
                fullWidth
                type="password"
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                variant="outlined"
                className="auth-input"
                autoComplete="current-password"
              />

              {error && (
                <Typography variant="body2" className="auth-error">
                  {error}
                </Typography>
              )}

              <Button
                type="submit"
                fullWidth
                variant="contained"
                className="auth-submit"
              >
                {formState === 0 ? "Login" : "Register"}
              </Button>
            </Box>
          </Box>
        </Grid>
      </Grid>

      <Snackbar
        open={open}
        autoHideDuration={4000}
        onClose={() => setOpen(false)}
        message={message}
      />
    </ThemeProvider>
  );
}